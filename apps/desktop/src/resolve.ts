/**
 * Finding the user's `alp` and a PATH to run it with. An app started from Finder gets
 * PATH=/usr/bin:/bin:/usr/sbin:/sbin, and an npm-installed alp is `#!/usr/bin/env node`, so both alp
 * and node must be found. Order: the explicit setting (or ALP_DESKTOP_ALP), the global bin
 * directories alp-client also searches (packages/client/src/index.js BIN_DIRECTORIES), then the
 * user's login shell (with a timeout, since rc files can hang).
 */
import path from 'node:path';

export type LoginShell = () => Promise<{ alp?: string; path?: string } | undefined>;

export type ResolveDeps = {
  home: string;
  /** PATH of this process. */
  envPath: string | undefined;
  /** An explicit alp path: the app setting, else ALP_DESKTOP_ALP. */
  override?: string;
  isExecutable: (file: string) => Promise<boolean>;
  loginShell: LoginShell;
};

export type Resolved =
  | { alp: string; path: string }
  | { missing: true; override?: string };

/** The global bin directories, in alp-client's order. */
export const binDirectories = (home: string): string[] => [
  path.join(home, '.alp', 'bin'),
  path.join(home, '.npm-global', 'bin'),
  path.join(home, '.local', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
];

const joinPath = (parts: (string | undefined)[]): string => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) for (const dir of (part ?? '').split(':')) {
    if (dir && !seen.has(dir)) { seen.add(dir); out.push(dir); }
  }
  return out.join(':');
};

async function findOn(name: string, pathValue: string, isExecutable: ResolveDeps['isExecutable']): Promise<string | undefined> {
  for (const dir of pathValue.split(':').filter(Boolean)) {
    const file = path.join(dir, name);
    if (await isExecutable(file)) return file;
  }
  return undefined;
}

export async function resolveAlp(deps: ResolveDeps): Promise<Resolved> {
  const fixed = binDirectories(deps.home);
  let shell: { alp?: string; path?: string } | undefined;
  let shellAsked = false;
  const askShell = async () => {
    if (!shellAsked) { shellAsked = true; shell = await deps.loginShell().catch(() => undefined); }
    return shell;
  };

  let alp: string | undefined;
  if (deps.override) {
    // An explicit setting is used or reported, never silently replaced by another alp.
    if (!path.isAbsolute(deps.override) || !await deps.isExecutable(deps.override)) return { missing: true, override: deps.override };
    alp = deps.override;
  }
  alp ??= await findOn('alp', joinPath(fixed), deps.isExecutable);
  if (!alp) {
    const found = (await askShell())?.alp;
    if (found && path.isAbsolute(found) && await deps.isExecutable(found)) alp = found;
  }
  if (!alp) return { missing: true };

  let pathValue = joinPath([path.dirname(alp), ...fixed, deps.envPath]);
  // alp from npm runs on `env node`: when node is not on that PATH, add the login shell's PATH.
  if (!await findOn('node', pathValue, deps.isExecutable)) pathValue = joinPath([pathValue, (await askShell())?.path]);
  return { alp, path: pathValue };
}

/** Parses the login shell probe's output: line 1 `command -v alp` (may be empty), line 2 $PATH. */
export function parseShellProbe(stdout: string): { alp?: string; path?: string } {
  const marker = '__ALP_DESKTOP__';
  const start = stdout.lastIndexOf(marker);
  if (start < 0) return {};
  const [alp = '', pathValue = ''] = stdout.slice(start + marker.length).replace(/^\r?\n/, '').split(/\r?\n/);
  return { alp: alp.trim() || undefined, path: pathValue.trim() || undefined };
}

/** The script the login shell runs; rc files may print noise, so the answer follows a marker. */
export const SHELL_PROBE = "printf '__ALP_DESKTOP__\\n'; printf '%s\\n' \"$(command -v alp 2>/dev/null)\"; printf '%s\\n' \"$PATH\"";
