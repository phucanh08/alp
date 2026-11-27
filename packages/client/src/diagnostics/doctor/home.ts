import { realpathSync } from 'node:fs';
import { chmod, lstat, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DoctorCheck } from './types.ts';

/** Files and directories under ALP_HOME that hold logs, state or settings. */
async function privateEntries(home: string): Promise<string[]> {
  const entries = [home];
  for (const name of ['settings.json', 'alpd.lock', 'alpd.json', 'role-skills.json']) entries.push(path.join(home, name));
  for (const directory of ['state', 'runs', 'logs', 'boards', 'worktrees', 'copies']) {
    const full = path.join(home, directory);
    entries.push(full);
    if (directory === 'worktrees' || directory === 'copies') continue;
    for (const name of await readdir(full).catch(() => [])) entries.push(path.join(full, name));
  }
  return entries;
}

export async function permissionsCheck(home: string): Promise<DoctorCheck> {
  // Windows files have no group/other mode bits to read or tighten; the profile's ACL keeps the home private.
  if (process.platform === 'win32') return { id: 'permissions', status: 'ok', summary: `${home} follows your Windows profile access rules` };
  const open: Array<{ entry: string; mode: number; directory: boolean }> = [];
  for (const entry of await privateEntries(home)) {
    const info = await lstat(entry).catch(() => undefined);
    if (!info || info.isSymbolicLink() || !(info.mode & 0o077)) continue;
    open.push({ entry, mode: info.mode & 0o777, directory: info.isDirectory() });
  }
  if (!open.length) return { id: 'permissions', status: 'ok', summary: `${home} is private to you` };
  return {
    id: 'permissions', status: 'warn',
    summary: `${open.length} entr${open.length > 1 ? 'ies' : 'y'} under ${home} readable by others; they hold task briefs, results and settings`,
    details: open.map(item => `${item.mode.toString(8).padStart(4, '0')} ${item.entry}`),
    fix: {
      describe: 'remove group and other access from them',
      async apply() {
        for (const item of open) await chmod(item.entry, item.mode & 0o700).catch(() => {});
        return `tightened ${open.length} entr${open.length > 1 ? 'ies' : 'y'}`;
      },
    },
  };
}

/** Checks whether directory `target` is inside directory `container`. */
function isInside(target: string, container: string): boolean {
  const resolve = (directory: string): string => {
    let current = path.resolve(directory);
    let suffix = '';
    for (;;) {
      try { return path.join(realpathSync(current), suffix); }
      catch {
        const parent = path.dirname(current);
        if (parent === current) return path.join(current, suffix);
        suffix = path.join(path.basename(current), suffix);
        current = parent;
      }
    }
  };
  const resolvedTarget = resolve(target);
  const resolvedContainer = resolve(container);
  const relative = path.relative(resolvedContainer, resolvedTarget);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * Checks where ALP_HOME sits: staging and state live there (§12.6). Sandboxed sessions
 * can write the temp directory and their workspace, so staged copies inside either could
 * be modified by a sandboxed tool before alpd reads them (ALP_ATTACHMENT_STAGE_EXPOSED).
 */
export async function homeLocationCheck(home: string | undefined, project: string | undefined): Promise<DoctorCheck> {
  if (process.platform === 'win32' || !home) return { id: 'home', status: 'ok', summary: home ?? '' };
  if (project && isInside(home, project)) {
    return {
      id: 'home', status: 'warn',
      summary: `ALP_HOME (${home}) is inside this project's workspace, which sandboxed sessions may write: a tool could change staged attachment copies before they are read; keep ALP_HOME outside workspaces (default ~/.alp)`,
    };
  }
  const inTmp = isInside(home, os.tmpdir()) || isInside(home, '/tmp');
  if (inTmp) {
    return {
      id: 'home', status: 'warn',
      summary: `ALP_HOME (${home}) is inside the temp directory, which sandboxed sessions may write: a tool could change staged attachment copies before they are read; keep ALP_HOME outside it (default ~/.alp)`,
    };
  }
  return { id: 'home', status: 'ok', summary: home };
}
