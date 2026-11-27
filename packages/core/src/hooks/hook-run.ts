import { signalShell, spawnShell } from '../_shared/shell.ts';
import type { Readable } from 'node:stream';

const OUTPUT_LIMIT = 64 * 1024;
const GRACE_MS = 2000;

/**
 * Runs a hook's command once (ALPD §43): through /bin/sh (cmd.exe on Windows) in `cwd`, with the event as JSON
 * on stdin and `env` added to ALP's environment. It runs in its own process group, so
 * past its timeout the whole group gets SIGTERM, then SIGKILL two seconds later; a
 * shell's children do not outlive it. Output beyond 64 KiB per stream is cut.
 * @param {{ command: string, timeoutSec?: number }} hook
 * @param {unknown} payload
 * @param {{ cwd: string, env?: Record<string, string>, timeoutMs?: number }} options
 * @returns {Promise<{ exitCode: number | null, signal: string | null, timedOut: boolean, stdout: string, stderr: string, durationMs: number }>}
 */
export function runHook(hook: { command: string, timeoutSec?: number }, payload: unknown, { cwd, env = {}, timeoutMs }: { cwd?: string, env?: Record<string, string>, timeoutMs?: number } = {}): Promise<{ exitCode: number | null, signal: string | null, timedOut: boolean, stdout: string, stderr: string, durationMs: number }> {
  const limit = timeoutMs ?? (hook.timeoutSec ?? 60) * 1000;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawnShell(hook.command, { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const signal = (name: NodeJS.Signals) => signalShell(child, name);
    const output = { stdout: '', stderr: '' };
    for (const stream of ['stdout', 'stderr'] as const) {
      (child[stream] as Readable).setEncoding('utf8');
      (child[stream] as Readable).on('data', (chunk: string) => { if (output[stream].length < OUTPUT_LIMIT) output[stream] = (output[stream] + chunk).slice(0, OUTPUT_LIMIT); });
    }
    let timedOut = false;
    let kill: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      signal('SIGTERM');
      kill = setTimeout(() => signal('SIGKILL'), GRACE_MS);
    }, limit);
    child.on('error', error => { clearTimeout(timer); clearTimeout(kill); reject(error); });
    // A background process the hook started may keep its output open; the hook is done when its shell exits.
    child.on('exit', () => setTimeout(() => { child.stdout!.destroy(); child.stderr!.destroy(); }, 200).unref());
    child.on('close', (exitCode, signalName) => {
      clearTimeout(timer);
      clearTimeout(kill);
      resolve({ exitCode, signal: signalName, timedOut, ...output, durationMs: Date.now() - started });
    });
    // A command that does not read stdin closes it early; that is not an error.
    child.stdin!.on('error', () => {});
    child.stdin!.end(JSON.stringify(payload) + '\n');
  });
}

/** A payload like the one ALP sends for an event, for trying a hook out. */
export function samplePayload(event: string, { project, agent = 'main', session = 'alp-sample-session', task }: { project?: string, agent?: string, session?: string, task?: string } = {}) {
  return {
    event, sample: true, project, session, agent,
    ...(task ? { task } : {}),
    ...(event === 'handoff' ? { handoff: { outcome: 'complete', summary: 'Sample handoff for a hook test' } } : {}),
    ...(event === 'task.close' ? { task: task ?? 'alp-sample', reason: 'done' } : {}),
    ...(event === 'merge' ? { branch: 'alp/sample', files: [] } : {}),
  };
}
