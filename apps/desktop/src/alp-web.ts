/**
 * Running the user's `alp` (no shell, never logged): `alp web --print` starts or attaches the
 * alp-web service and prints its address with the token in the fragment.
 */
import { access, constants, stat } from 'node:fs/promises';
import os from 'node:os';
import { parseAlpWebOutput, type AlpWebAddress } from './url';
import { parseShellProbe, resolveAlp, SHELL_PROBE, type Resolved } from './resolve';
import { run } from './run';

/** Starting alpd and alp-web on a cold machine can take a while. */
const PRINT_TIMEOUT_MS = 90_000;
const SHELL_TIMEOUT_MS = 5_000;

export type Connect =
  | { ok: true; address: AlpWebAddress }
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

/** Resolves alp and asks it for the address. The address is returned, never printed. */
export async function connectAlpWeb(override: string | undefined): Promise<Connect> {
  const resolved = await findAlp(override);
  if ('missing' in resolved) return { ok: false, missing: true, override: resolved.override };
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: resolved.path };
  // Electron's own switches must not reach a node that alp starts.
  delete env.ELECTRON_RUN_AS_NODE;
  const result = await run(resolved.alp, ['web', '--print'], { env, timeout: PRINT_TIMEOUT_MS });
  if (result.code === 0) {
    const address = parseAlpWebOutput(result.stdout);
    if (address) return { ok: true, address };
    return { ok: false, error: '`alp web --print` did not print an ALP web address. Update ALP, then try again.' };
  }
  // alp's own message (web disabled, refused, not built…) is shown as is; stdout may hold the
  // address, so it is never shown.
  if (result.timedOut) return { ok: false, error: `\`alp web --print\` did not answer within ${PRINT_TIMEOUT_MS / 1000} seconds.` };
  const message = result.stderr.trim() || result.error?.message || `alp exited with code ${result.code}`;
  return { ok: false, error: message.replace(/^error:\s*/i, '') };
}
