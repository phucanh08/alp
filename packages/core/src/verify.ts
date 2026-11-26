import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AlpError } from './errors.ts';
import { signalShell, spawnShell } from './shell.ts';

/**
 * The project's verification gate (plans/reference/ALPD.md §28): commands from
 * `verify` in .alp/settings.json that alpd runs before it applies an assignment's
 * change, and after a writer in the shared checkout. They run in order and stop
 * at the first failure.
 */

export const VERIFY_STEPS: readonly ['setup', 'typecheck', 'test'] = ['setup', 'typecheck', 'test'];
export const VERIFY_TIMEOUT_SEC: number = 600;
/** How long a stopped command gets between SIGTERM and SIGKILL. */
export const VERIFY_GRACE_MS: number = 5000;
/** The exit code (EX_TEMPFAIL) by which a step says it could not run, rather than that the change is wrong. */
export const VERIFY_INFRA_EXIT: number = 75;
const COMMAND_CHARS = 2000;
const OUTPUT_CHARS = 4000;

// any: settings are unvalidated JSON; a value that passes is an object whose fields are then checked one by one
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail: (source: string, message: string) => never = (source, message) => { throw new AlpError('INVALID_SETTINGS', `${source}: ${message}`); };

export type VerifyConfig = { setup?: string; typecheck?: string; test?: string; timeoutSec: number; idleSec?: number };

export type VerifyCommand = { step: 'setup' | 'typecheck' | 'test'; command: string; exitCode: number; ms: number; output: string; timedOut?: boolean; idle?: boolean };

export type Verification = { passed: boolean; cwd: string; commands: VerifyCommand[]; skipped?: string };

/** Checks a `verify` setting; returns it normalized, or undefined when absent. */
export function validateVerify(verify: unknown, source: string): VerifyConfig | undefined {
  if (verify === undefined) return undefined;
  if (!object(verify)) fail(source, 'verify must be an object');
  const extra = Object.keys(verify).filter(key => !([...VERIFY_STEPS, 'timeoutSec', 'idleSec'] as string[]).includes(key));
  if (extra.length) fail(source, `unsupported verify field '${extra[0]}'; use ${VERIFY_STEPS.join(', ')}, timeoutSec and idleSec`);
  for (const step of VERIFY_STEPS) {
    if (verify[step] !== undefined && (typeof verify[step] !== 'string' || !verify[step].trim() || verify[step].length > COMMAND_CHARS)) fail(source, `verify.${step} must be a command of at most ${COMMAND_CHARS} characters`);
  }
  if (!VERIFY_STEPS.some(step => verify[step] !== undefined)) fail(source, `verify needs at least one of ${VERIFY_STEPS.join(', ')}`);
  if (verify.timeoutSec !== undefined && (!Number.isSafeInteger(verify.timeoutSec) || verify.timeoutSec < 1 || verify.timeoutSec > 7200)) fail(source, 'verify.timeoutSec must be 1 to 7200 seconds');
  if (verify.idleSec !== undefined && (!Number.isSafeInteger(verify.idleSec) || verify.idleSec < 1 || verify.idleSec > 7200)) fail(source, 'verify.idleSec must be 1 to 7200 seconds');
  return {
    ...Object.fromEntries(VERIFY_STEPS.filter(step => verify[step] !== undefined).map(step => [step, verify[step].trim()])),
    timeoutSec: verify.timeoutSec ?? VERIFY_TIMEOUT_SEC,
    ...(verify.idleSec !== undefined ? { idleSec: verify.idleSec } : {}),
  };
}

/** The project's verify setting, or undefined when it has none. */
export async function verifyConfig(projectRoot: string): Promise<VerifyConfig | undefined> {
  const file = path.join(projectRoot, '.alp', 'settings.json');
  let text;
  try { text = await readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  let settings;
  try { settings = JSON.parse(text); } catch (error) { fail(file, `invalid JSON: ${(error as Error).message}`); }
  return object(settings) ? validateVerify(settings.verify, file) : undefined;
}

/**
 * Runs one command through the shell, keeping the end of its output. When it runs
 * past `timeoutMs`, or prints nothing for `idleMs`, its process group gets SIGTERM,
 * then SIGKILL after VERIFY_GRACE_MS, so its own cleanup can run.
 */
type CommandResult = { exitCode: number, ms: number, output: string, timedOut?: boolean, idle?: boolean, spawnError?: boolean };

function runCommand(command: string, cwd: string, { timeoutMs, idleMs }: { timeoutMs: number, idleMs?: number }, env: NodeJS.ProcessEnv): Promise<CommandResult> {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawnShell(command, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let stopped: 'timeout' | 'idle' | undefined;
    let idle: NodeJS.Timeout | undefined;
    const signal = (name: NodeJS.Signals) => signalShell(child, name);
    const stop = (reason: 'timeout' | 'idle') => {
      if (stopped) return;
      stopped = reason;
      signal('SIGTERM');
      setTimeout(() => signal('SIGKILL'), VERIFY_GRACE_MS).unref();
    };
    const quiet = () => {
      if (!idleMs) return;
      clearTimeout(idle);
      idle = setTimeout(() => stop('idle'), idleMs);
    };
    const keep = (chunk: Buffer | string) => { output = (output + chunk).slice(-OUTPUT_CHARS * 2); quiet(); };
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    quiet();
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    let done = false;
    const finish = (exitCode: number, error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(idle);
      const tail = output.length > OUTPUT_CHARS ? `…${output.slice(-OUTPUT_CHARS)}` : output;
      resolve({
        exitCode, ms: Date.now() - started, output: error ? `${tail}${error}` : tail,
        ...(stopped === 'timeout' ? { timedOut: true } : stopped === 'idle' ? { idle: true } : {}),
        ...(error ? { spawnError: true } : {}),
      });
    };
    child.once('error', error => finish(127, error.message));
    child.once('close', (code, signal) => finish(stopped ? 124 : code ?? (signal ? 128 : 1)));
  });
}

/**
 * Runs the configured steps in `cwd`, in order, stopping at the first failure.
 * A step that exits VERIFY_INFRA_EXIT, or whose shell does not start, ends the run as skipped.
 * @returns {Promise<{ passed: boolean, cwd: string, skipped?: string, commands: Array<{ step: string, command: string, exitCode: number, ms: number, output: string, timedOut?: boolean, idle?: boolean }> }>}
 */
export async function runVerify(cwd: string, config: VerifyConfig, { env = process.env }: { env?: NodeJS.ProcessEnv } = {}): Promise<Verification> {
  const commands: VerifyCommand[] = [];
  for (const step of VERIFY_STEPS) {
    if (!config[step]) continue;
    const { spawnError, ...result } = await runCommand(config[step]!, cwd, { timeoutMs: config.timeoutSec * 1000, idleMs: config.idleSec ? config.idleSec * 1000 : undefined }, { ...env, ALP_VERIFY: '1' });
    commands.push({ step, command: config[step]!, ...result });
    // A step that could not run says nothing about the change: the check is skipped, not failed.
    if (spawnError || result.exitCode === VERIFY_INFRA_EXIT) {
      return { passed: false, cwd, commands, skipped: `infra: ${step} could not run (${spawnError ? 'the shell did not start' : `exit ${VERIFY_INFRA_EXIT}`})` };
    }
    if (result.exitCode !== 0) return { passed: false, cwd, commands };
  }
  return { passed: true, cwd, commands };
}

/** One line for a verification: passed, or the step that failed. */
export function describeVerification(verified: { passed: boolean; commands: Array<{ step: string; exitCode: number; timedOut?: boolean; idle?: boolean }>; skipped?: string }): string {
  if (verified.skipped) return `verification skipped: ${verified.skipped}`;
  const failed = verified.commands.find(command => command.exitCode !== 0);
  return verified.passed ? `verified (${verified.commands.map(command => command.step).join(', ')})`
    : `verification failed: ${failed!.step} ${failed!.timedOut ? 'timed out' : failed!.idle ? 'printed nothing for too long' : `exited ${failed!.exitCode}`}`;
}
