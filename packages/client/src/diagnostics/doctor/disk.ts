import { lstat, readdir, statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../../_shared/command.ts';
import type { DiskCheckOptions, DoctorCheck, Leftover } from './types.ts';
import { LEFTOVER_STATES, NOT_CHECKED, classifyLeftovers, ownedPaths, printable, realpathOr } from './leftovers.ts';

const GIB = 1024 ** 3;
const formatSize = (bytes: number): string => bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;

/** Entries of `directory` whose names start with `prefix`, as full paths; none when it cannot be read. */
async function entries(directory: string, prefix = ''): Promise<string[]> {
  const names = await readdir(directory).catch(() => []);
  return names.filter(name => name.startsWith(prefix)).map(name => path.join(directory, name));
}

/** How many suggested commands the text output shows; --json lists every one. */
const SHOWN_COMMANDS = 20;

/**
 * Free space where ALP_HOME lives (t-2831), and what earlier runs left that takes room:
 * worktrees under ALP_HOME/worktrees and alp-* directories in the temp directory. When
 * the disk fills, alpd pauses work instead of stopping; this says so before it happens.
 * Nothing is deleted, by --fix either: a leftover may hold someone's uncommitted work.
 * Each leftover is classified (t-e80a): clean and pushed, dirty, local-only data, unpushed, in use, or
 * unknown; only a clean and pushed one gets a command, for the user to run by hand.
 * Classifying stops after `classifyMs` (10 s); what it did not reach is unknown. A clean one
 * changed within `recentMs` (a day) is in use: someone may have just started in it.
 */
export async function diskCheck(home: string, { run = runCommand, env = process.env, free, tempDirs = [...new Set([os.tmpdir(), ...(process.platform === 'win32' ? [] : ['/tmp'])])], cwd = process.cwd(), classifyMs = 10_000, recentMs = 24 * 60 * 60 * 1000, platform = process.platform }: DiskCheckOptions = {}): Promise<DoctorCheck & { leftovers?: Leftover[] }> {
  let bytes = free;
  if (bytes === undefined) {
    try { const info = await statfs(home); bytes = Number(info.bavail) * Number(info.bsize); } catch {}
  }
  const worktrees = await entries(path.join(home, 'worktrees'));
  const temp: string[] = [];
  for (const directory of tempDirs) {
    for (const entry of await entries(directory, 'alp-')) {
      const info = await lstat(entry).catch(() => undefined);
      if (info?.isDirectory() && !temp.includes(realpathOr(entry))) temp.push(realpathOr(entry));
    }
  }
  /** Kilobytes du counts under the paths; undefined when du is missing, slow or fails. */
  async function size(paths: string[]): Promise<number | undefined> {
    if (!paths.length) return 0;
    if (process.platform === 'win32') return undefined;
    const result = await run('du', ['-sk', ...paths], { env, timeoutMs: 20_000 });
    if (result.code !== 0 && !result.stdout) return undefined;
    const total = result.stdout.split('\n').reduce((sum, line) => sum + (Number(line.split(/\s+/)[0]) || 0), 0);
    return total * 1024;
  }
  // git must answer about each leftover itself, not about a repository the caller's environment names,
  // and only read: GIT_OPTIONAL_LOCKS=0 keeps git status from refreshing the index of a worktree in use.
  const gitEnv = { ...Object.fromEntries(Object.entries(env).filter(([name]) => !/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|NAMESPACE|CEILING_DIRECTORIES)$/.test(name))), GIT_OPTIONAL_LOCKS: '0' };
  const groups = ([[`${path.join(home, 'worktrees')}`, worktrees], [`${tempDirs.map(directory => path.join(directory, 'alp-*')).join(', ')}`, temp]] as Array<[label: string, paths: string[]]>).filter(([, paths]) => paths.length);
  // Sizing and classifying run side by side: du alone can take many seconds over thousands of leftovers.
  const [sizes, leftovers] = await Promise.all([
    Promise.all(groups.map(([, paths]) => size(paths))),
    ownedPaths(home).then(owned => classifyLeftovers([...new Set([...worktrees, ...temp])], { run, env: gitEnv, owned, here: realpathOr(cwd), budgetMs: classifyMs, recentMs, platform })),
  ]);
  const details = groups.map(([label, paths], index) => `${paths.length} left in ${label}${sizes[index] === undefined ? '' : `, ${formatSize(sizes[index])}`}`);
  for (const [state, meaning] of Object.entries(LEFTOVER_STATES)) {
    const count = leftovers.filter(entry => entry.state === state).length;
    if (count) details.push(`${count} ${meaning}`);
  }
  const unchecked = leftovers.filter(entry => entry.reason === NOT_CHECKED).length;
  if (unchecked) details.push(`  ${unchecked} of the unknown were not checked within ${classifyMs < 1000 ? `${classifyMs} ms` : `${Math.round(classifyMs / 1000)} s`}`);
  // A clean and pushed leftover whose path no command can safely carry is listed by its path alone,
  // as a shell comment: pasted with the rest, it runs nothing.
  const commands = leftovers.filter(entry => entry.state === 'clean-pushed').map(entry => entry.command ?? `# remove by hand after checking (no safe command): ${printable(entry.path)}`);
  for (const command of commands.slice(0, SHOWN_COMMANDS)) details.push(`  ${command}`);
  if (commands.length > SHOWN_COMMANDS) details.push(`  … ${commands.length - SHOWN_COMMANDS} more; alp doctor --json lists every one`);
  const hint = details.length ? 'ALP deletes none of these, and --fix does not either. Only a clean and pushed leftover gets a command, for you to run by hand, and only when its path is plain ASCII; inspect the others before removing anything.' : undefined;
  const where = bytes === undefined ? 'free space unknown' : `${formatSize(bytes)} free`;
  // Leftovers never change the status: some may be live.
  const status = bytes !== undefined && bytes < 2 * GIB ? 'warn' : 'ok';
  const summary = bytes !== undefined && bytes < 2 * GIB
    ? `${where} where ALP_HOME lives; when the disk is full, alpd pauses all work until space returns`
    : `${where} where ALP_HOME lives`;
  return { id: 'disk', status, summary, ...(details.length ? { details } : {}), ...(hint ? { hint } : {}), ...(leftovers.length ? { leftovers } : {}) };
}
