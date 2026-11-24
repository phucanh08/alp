/**
 * Running the user's `alp` (no shell, never logged): `alp dashboard --print --json` starts or attaches
 * the alp-dashboard service and answers with one line of JSON (docs/alp/dashboard.md §3.3) that holds
 * its address with the token in the fragment. An alp from before that contract (0.0.1-beta.9 to
 * beta.13) is asked with `alp dashboard --print` and its last line is matched instead.
 */
import { access, constants, stat } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import { parseDashboardOutput, validateDashboardUrl, type DashboardAddress } from './url';
import { parseShellProbe, resolveAlp, SHELL_PROBE, type Resolved } from './resolve';
import { run, type RunResult } from './run';

/** Starting alpd and alp-dashboard on a cold machine can take a while. */
const PRINT_TIMEOUT_MS = 90_000;
const SHELL_TIMEOUT_MS = 5_000;

export type Connect =
  | { ok: true; address: DashboardAddress }
  | { ok: false; missing: true; override?: string }
  | { ok: false; error: string };

/** A regular file this user may execute (a directory has the x bit too, and is refused). */
export const isExecutable = async (file: string) => {
  try {
    if (!(await stat(file)).isFile()) return false;
    await access(file, constants.X_OK);
    return true;
  } catch { return false; }
};

/** The user's login shell's `alp` and PATH, or undefined when it fails or takes too long. */
async function loginShell(): Promise<{ alp?: string; path?: string } | undefined> {
  const shell = process.env.SHELL && process.env.SHELL.startsWith('/') ? process.env.SHELL : '/bin/zsh';
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // An interactive shell ignores SIGTERM and an rc file may leave a job holding stdout: run() kills
  // the shell's whole group with SIGKILL at the deadline and answers without waiting for the pipe.
  const result = await run(shell, ['-ilc', SHELL_PROBE], { env, timeout: SHELL_TIMEOUT_MS, killGroup: true });
  return result.code === 0 ? parseShellProbe(result.stdout) : undefined;
}

export function findAlp(override: string | undefined): Promise<Resolved> {
  return resolveAlp({ home: os.homedir(), envPath: process.env.PATH, override, isExecutable, loginShell });
}

/** The contract this app reads: docs/alp/dashboard.md §3.3. */
const PRINT_SCHEMA = 'alp.dashboard.print';
const PRINT_VERSION = 1;

/** What the JSON line of `alp dashboard --print --json` says, or undefined when stdout has no such line. */
export type PrintAnswer =
  | { ok: true; url: string }
  | { ok: false; code: string; message: string }
  | { unsupported: number };

/**
 * Reads the answer of `alp dashboard --print --json`: the last line of stdout that is not empty, when it
 * is a JSON object of schema `alp.dashboard.print`. A version this app does not know is reported, not
 * guessed at; fields it does not know are ignored. The url is not checked here (validateDashboardUrl).
 */
export function parsePrintAnswer(stdout: string): PrintAnswer | undefined {
  const last = String(stdout ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1);
  if (last === undefined || !last.startsWith('{')) return undefined;
  let value: unknown;
  try { value = JSON.parse(last); } catch { return undefined; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const answer = value as Record<string, unknown>;
  if (answer.schema !== PRINT_SCHEMA || typeof answer.version !== 'number') return undefined;
  if (answer.version !== PRINT_VERSION) return { unsupported: answer.version };
  if (answer.ok === true) return typeof answer.url === 'string' ? { ok: true, url: answer.url } : undefined;
  if (answer.ok !== false) return undefined;
  const error = answer.error && typeof answer.error === 'object' ? answer.error as Record<string, unknown> : {};
  return { ok: false, code: typeof error.code === 'string' ? error.code : 'failed', message: typeof error.message === 'string' ? error.message : '' };
}

const NO_ADDRESS = '`alp dashboard --print` did not print an ALP dashboard address. Update ALP, then try again.';

/** Resolves alp and asks it for the address. The address is returned, never printed. */
export async function connectDashboard(override: string | undefined): Promise<Connect> {
  const resolved = await findAlp(override);
  if ('missing' in resolved) return { ok: false, missing: true, override: resolved.override };
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: resolved.path };
  // Electron's own switches must not reach a node that alp starts.
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await run(resolved.alp, ['dashboard', '--print', '--json'], { env, timeout: PRINT_TIMEOUT_MS });
  if (result.timedOut) return timedOut();
  const answer = parsePrintAnswer(result.stdout);
  if (answer && 'unsupported' in answer) {
    return { ok: false, error: `Your alp (${resolved.alp}) answers \`alp dashboard --print --json\` in version ${answer.unsupported} of its format; this ALP desktop app reads version ${PRINT_VERSION}. Update the ALP desktop app.` };
  }
  if (answer?.ok) {
    // The window only ever opens the user's own loopback alp dashboard, whatever the JSON says.
    const address = result.code === 0 ? validateDashboardUrl(answer.url) : undefined;
    return address ? { ok: true, address } : { ok: false, error: NO_ADDRESS };
  }
  // alp's own message (disabled, refused, not built…), as its JSON gives it.
  if (answer) return { ok: false, error: answer.message.replace(/^error:\s*/i, '') || `alp dashboard failed (${answer.code}, exit code ${result.code})` };
  // No JSON and the usage text: an alp that does not know --json. Ask it the way it knows.
  if (isUsage(result)) return connectLegacy(resolved.alp, env);
  return failed(result);
}

/**
 * An alp from before `--json` (0.0.1-beta.13 and older): `alp dashboard --print` prints the address as
 * its last line. Kept so a new ALP.app still opens an alp that was not updated with it; the app and
 * the CLI are installed separately (docs/alp/desktop.md).
 */
async function connectLegacy(alp: string, env: NodeJS.ProcessEnv): Promise<Connect> {
  const result = await run(alp, ['dashboard', '--print'], { env, timeout: PRINT_TIMEOUT_MS });
  const address = result.code === 0 ? parseDashboardOutput(result.stdout) : undefined;
  if (address) return { ok: true, address };
  // An alp older than `alp dashboard` (0.0.1-beta.8 and before) answers with its usage text.
  if (!result.timedOut && isUsage(result)) return { ok: false, error: await tooOld(alp, env) };
  if (result.timedOut) return timedOut();
  return failed(result);
}

const timedOut = (): Connect => ({ ok: false, error: `\`alp dashboard --print\` did not answer within ${PRINT_TIMEOUT_MS / 1000} seconds.` });

/** A run that gave no address. stdout may hold one (or a token), so it is never shown. */
function failed(result: RunResult): Connect {
  if (result.code === 0) return { ok: false, error: NO_ADDRESS };
  // alp's own message (web disabled, refused, not built…) is shown as is.
  const message = result.stderr.trim() || result.error?.message || `alp exited with code ${result.code}`;
  return { ok: false, error: message.replace(/^error:\s*/i, '') };
}

const VERSION_TIMEOUT_MS = 10_000;

/** Whether alp answered with its usage text: it does not know the command or one of its options. */
const isUsage = (result: RunResult) => /^Usage:/.test(result.stderr.trim()) || /^Usage:/.test(result.stdout.trim());

/** The message for an alp without `alp dashboard`, naming its version when `alp --version` gives one. */
async function tooOld(alp: string, env: NodeJS.ProcessEnv): Promise<string> {
  const result = await run(alp, ['--version'], { env, timeout: VERSION_TIMEOUT_MS });
  const line = result.code === 0 ? result.stdout.trim().split(/\r?\n/, 1)[0] : '';
  const version = /^\d+\.\d+\.\d+[0-9A-Za-z.+-]*$/.test(line) ? ` ${line}` : '';
  return `Your alp${version} (${alp}) has no \`alp dashboard\`, which the ALP desktop app needs. Update ALP with \`alp update\`, or install a build from main.`;
}

/** How long a /readyz probe may take before it counts as no answer. */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Whether alp dashboard at `origin` answers HTTP: GET /readyz, any status. 503 means alpd is not ready,
 * which the page handles by itself; only no answer (refused, reset, timeout) means alp dashboard is gone.
 * No credential is sent.
 */
export function probeDashboard(origin: string, timeout = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise(resolve => {
    let request: http.ClientRequest;
    try {
      request = http.get(`${origin}/readyz`, { timeout, agent: false, headers: { accept: 'application/json' } }, response => {
        response.resume();
        resolve(true);
      });
    } catch { resolve(false); return; }
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', () => resolve(false));
  });
}
