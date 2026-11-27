import { realpathSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CommandRunner } from '../../_shared/command.ts';
import type { Leftover, LeftoverState } from './types.ts';

/** What classifying a leftover needs besides its path. */
type ClassifyOptions = { run: CommandRunner; env: NodeJS.ProcessEnv; owned: Set<string>; here: string; recentMs: number; platform: NodeJS.Platform };

/**
 * What a path in a suggested command may hold, on every platform: ASCII letters and digits,
 * `. _ - / \\ :` and a space (common in Windows user folders; literal inside single quotes in sh
 * and PowerShell alike). Nothing else: no quote of any kind (PowerShell ends a single-quoted string
 * at ' and at four typographic quotes), no shell syntax, no control, format or non-ASCII character.
 */
const QUOTABLE = /^[A-Za-z0-9._\-/\\: ]+$/;

/**
 * A path for a suggested command (POSIX sh, or PowerShell on win32), in single quotes; undefined
 * unless it is absolute (so it cannot read as an option) and every character is QUOTABLE, in which
 * case nothing in it needs escaping. A path that is not gets no command at all.
 */
export function shellQuote(text: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const value = String(text);
  const absolute = platform === 'win32' ? path.win32.isAbsolute(value) : path.posix.isAbsolute(value);
  return absolute && QUOTABLE.test(value) ? `'${value}'` : undefined;
}

/**
 * A path as alp doctor prints it: control, format and unusual space characters escaped as \u{hex},
 * so it stays one line and reads as it is. A backslash is doubled, so the escaping is injective:
 * a path that holds the text \u{a} prints as \\u{a}, never as a path with a newline would.
 */
export const printable = (text: unknown): string => String(text).replace(/\\|[\p{C}\p{Zl}\p{Zp}]|(?! )\p{Zs}/gu, char => char === '\\' ? '\\\\' : `\\u{${char.codePointAt(0)!.toString(16)}}`);

/** Why a clean and pushed leftover has no command. */
const UNQUOTABLE = 'no command: its path holds characters other than ASCII letters, digits, space and . _ - / \\ :, which a pasted command might not carry safely; check it and remove it by hand';

/** What each leftover state means, in the order alp doctor lists them. */
export const LEFTOVER_STATES: Record<LeftoverState, string> = {
  'clean-pushed': 'clean and pushed (no changes, no untracked or ignored files, and every commit and, for a clone, every ref on a remote it last fetched; remove by hand with the command shown, given only for a plain ASCII path)',
  dirty: 'dirty (uncommitted changes or untracked files, or a merge or rebase in progress; keep)',
  'local-only': 'local-only data (ignored files such as .env, local config, node_modules or build output, which exist only here; keep)',
  unpushed: 'unpushed (commits, or for a clone tags, branches or other refs, that no remote-tracking ref mirrors; keep)',
  'in-use': 'in use (a running assignment, a retained result, this shell, or changed in the last day; keep)',
  unknown: 'unknown (not a git checkout of its own, or git could not tell; check by hand)',
};

/** Paths ALP still owns: running assignments' worktrees and the retained results' checkouts. */
export async function ownedPaths(home: string): Promise<Set<string>> {
  const owned = new Set<string>();
  const read = async (file: string) => JSON.parse(await readFile(file, 'utf8'));
  const live = await read(path.join(home, 'state', 'live.json')).catch(() => []);
  for (const entry of Array.isArray(live) ? live : []) if (typeof entry?.worktree?.path === 'string') owned.add(realpathOr(entry.worktree.path));
  const ledger = await read(path.join(home, 'state', 'assignment-results.json')).catch(() => undefined);
  for (const entry of Array.isArray(ledger?.results) ? ledger.results : []) {
    if (entry?.handled) continue;
    for (const where of [entry?.worktree, entry?.checkout]) if (typeof where === 'string') owned.add(realpathOr(where));
  }
  return owned;
}

/** Why a leftover alp doctor had no time left for is unknown. */
export const NOT_CHECKED = 'not checked: alp doctor ran out of time; run it again, or check by hand';

/** Thrown when the classifying deadline passed: the leftover is unknown, not checked. */
class OutOfTime extends Error {}

/**
 * Classifies one leftover directory (t-e80a) without changing it: clean-pushed when it is a git
 * checkout of its own with no changes, no untracked files, no ignored files at all, no
 * hidden index state or submodules, no operation in progress, and a HEAD (for a standalone clone:
 * every ref, including tags and a stash) that a remote-tracking branch already holds. "Pushed" is
 * what this clone last fetched. Anything git cannot answer is unknown. Each git command ends by
 * `deadline`; past it the leftover is unknown, not checked.
 */
async function classifyLeftover(directory: string, { run, env, owned, here, recentMs, deadline, platform }: ClassifyOptions & { deadline: number }): Promise<Leftover> {
  const real = realpathOr(directory);
  const inside = (outer: string, inner: string): boolean => inner === outer || inner.startsWith(outer.endsWith(path.sep) ? outer : outer + path.sep);
  if ([...owned].some(owner => inside(real, owner) || inside(owner, real)) || inside(real, here)) return { path: directory, state: 'in-use' };
  const git = async (args: string[]) => {
    const left = deadline - Date.now();
    if (left <= 0) throw new OutOfTime();
    const result = await run('git', ['-C', directory, ...args], { env, timeoutMs: Math.min(10_000, left) });
    // A command cut off by the deadline says nothing about the leftover.
    if (Date.now() >= deadline) throw new OutOfTime();
    return result;
  };
  const unknown = (reason: string): Leftover => ({ path: directory, state: 'unknown', reason });
  // The top of every git checkout holds .git (a directory, or a file in a linked worktree): without it, no git is needed.
  if (!await lstat(path.join(directory, '.git')).then(() => true, () => false)) return unknown('not a git checkout');
  const where = await git(['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']);
  if (where.code !== 0) return unknown('not a git checkout');
  const [top, gitDir, common] = where.stdout.trim().split('\n');
  if (!top || !gitDir || !common || realpathOr(top) !== real) return unknown('not the top of a git checkout');
  const commonDir = realpathOr(path.resolve(top, common));
  // Untracked files are listed one by one whatever status.showUntrackedFiles says, and ignored ones
  // too: git status alone does not show an ignored .env, which exists nowhere else. Any ignored
  // file, node_modules and build output included, keeps the checkout: removing it loses them.
  // git lists an ignored directory as one entry.
  const status = await git(['-c', 'status.showUntrackedFiles=all', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching']);
  if (status.code !== 0) return unknown('git status failed');
  const rows = status.stdout.split('\0').filter(Boolean);
  if (rows.some(row => !row.startsWith('!! '))) return { path: directory, state: 'dirty' };
  const ignored = rows.map(row => row.slice(3));
  if (ignored.length) return { path: directory, state: 'local-only', reason: `ignored files: ${ignored.slice(0, 3).join(', ')}${ignored.length > 3 ? `, … ${ignored.length - 3} more` : ''}` };
  // git status cannot see a change to a file marked assume-unchanged or skip-worktree, nor inside a submodule.
  const index = await git(['ls-files', '-z', '-v', '--stage']);
  if (index.code !== 0) return unknown('git could not list its index');
  const tracked = index.stdout.split('\0').filter(Boolean);
  if (tracked.some(row => row[0] === 'S' || /[a-z]/.test(row[0]))) return unknown('some files are marked assume-unchanged or skip-worktree, which git status does not check');
  if (tracked.some(row => row.slice(2).startsWith('160000 '))) return unknown('it has submodules, whose own changes and commits this check does not read');
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    if (await lstat(path.join(gitDir, name)).then(() => true, () => false)) return { path: directory, state: 'dirty' };
  }
  // A worktree someone made by hand moments ago (a peer's, which ALP does not track) looks clean and pushed: recent work stays.
  const touched = Math.max(...await Promise.all([directory, path.join(gitDir, 'index'), path.join(gitDir, 'HEAD')].map(file => lstat(file).then(info => info.mtimeMs, () => 0))));
  if (Date.now() - touched < recentMs) return { path: directory, state: 'in-use', reason: 'changed in the last day' };
  const linked = realpathOr(gitDir) !== commonDir;
  // A linked worktree's branches live in its main repository and stay there when it goes; a clone
  // holds its own refs: every branch, tag, note and stash (--all), all of which must be on a remote.
  const ahead = await git(['rev-list', '-n', '1', ...(linked ? ['HEAD'] : ['HEAD', '--all']), '--not', '--remotes']);
  if (ahead.code !== 0) return unknown('git could not compare HEAD with the remotes');
  if (ahead.stdout.trim()) return { path: directory, state: 'unpushed' };
  if (!linked) {
    // A clone's refs go with it, and a tag (or note, or other ref) on a pushed commit is not seen
    // above. Without a fetch no one can tell which tags a remote has, so every local ref must be
    // mirrored by a remote-tracking ref: a branch by name (its commits are checked above), any
    // other ref by name and object (refs/tags/v1 by refs/remotes/<remote>/tags/v1).
    const refs = await git(['for-each-ref', '--format=%(objectname) %(refname)']);
    if (refs.code !== 0) return unknown('git could not list its refs');
    const all = refs.stdout.split('\n').filter(Boolean).map((line): [string, string] => { const at = line.indexOf(' '); return [line.slice(at + 1), line.slice(0, at)]; });
    // Matched by full ref name, refs/remotes/<remote>/<name> for a configured remote, so a branch
    // x is not taken for origin/feature/x (nor for a remote named feature's x unless feature is one).
    const remotes = await git(['remote']);
    if (remotes.code !== 0) return unknown('git could not list its remotes');
    const remoteNames = remotes.stdout.split('\n').map(line => line.trim()).filter(Boolean);
    const mirrors = new Map(all.filter(([name]) => name.startsWith('refs/remotes/')));
    const mirrored = ([name, object]: [string, string]): boolean => {
      const branch = name.startsWith('refs/heads/');
      const rest = branch ? name.slice('refs/heads/'.length) : name.slice('refs/'.length);
      return remoteNames.some(remote => {
        const target = mirrors.get(`refs/remotes/${remote}/${rest}`);
        return target !== undefined && (branch || target === object);
      });
    };
    const local = all.filter(entry => !entry[0].startsWith('refs/remotes/') && !mirrored(entry));
    if (local.length) return { path: directory, state: 'unpushed', reason: `local refs no remote-tracking ref mirrors: ${local.slice(0, 3).map(([name]) => name).join(', ')}${local.length > 3 ? `, … ${local.length - 3} more` : ''}` };
  }
  const list = await git(['worktree', 'list', '--porcelain']);
  if (list.code !== 0) return unknown('git could not list its worktrees');
  if (!linked) {
    // Removing a clone removes the repository of every worktree made from it.
    if ((list.stdout.match(/^worktree /gm) ?? []).length > 1) return { path: directory, state: 'in-use', reason: 'other worktrees use its repository' };
    const quoted = shellQuote(directory, platform);
    if (quoted === undefined) return { path: directory, state: 'clean-pushed', reason: UNQUOTABLE };
    return { path: directory, state: 'clean-pushed', command: platform === 'win32' ? `Remove-Item -LiteralPath ${quoted} -Recurse -Force` : `rm -rf ${quoted}` };
  }
  const main = list.stdout.match(/^worktree (.*)$/m)?.[1];
  if (!main) return unknown('git could not name its main worktree');
  const [quotedMain, quoted] = [shellQuote(main, platform), shellQuote(directory, platform)];
  if (quotedMain === undefined || quoted === undefined) return { path: directory, state: 'clean-pushed', reason: UNQUOTABLE };
  return { path: directory, state: 'clean-pushed', command: `git -C ${quotedMain} worktree remove ${quoted}` };
}

/**
 * Classifies leftovers eight at a time, within `budgetMs` in all: a machine can hold thousands
 * (old test homes in the temp directory), and doctor must still answer. The deadline is hard:
 * each git command is cut off when it comes, and doctor stops waiting then. Those not finished
 * by then are unknown.
 */
export async function classifyLeftovers(paths: string[], { budgetMs, ...options }: ClassifyOptions & { budgetMs: number }): Promise<Leftover[]> {
  const results: Leftover[] = paths.map(directory => ({ path: directory, state: 'unknown', reason: NOT_CHECKED }));
  const deadline = Date.now() + budgetMs;
  let next = 0, done = false;
  const worker = async () => {
    while (!done && next < paths.length && Date.now() < deadline) {
      const index = next++;
      try {
        const result = await classifyLeftover(paths[index], { ...options, deadline });
        if (!done && Date.now() < deadline) results[index] = result;
      } catch (error) { if (!(error instanceof OutOfTime)) results[index] = { path: paths[index], state: 'unknown', reason: `could not check: ${(error as Error | undefined)?.message ?? error}` }; }
    }
  };
  // A file system call that hangs (a stale network mount) is not cut off by a command timeout: stop waiting at the deadline.
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, budgetMs)); });
  await Promise.race([Promise.all(Array.from({ length: Math.min(8, paths.length) }, worker)), expired]);
  clearTimeout(timer);
  done = true;
  return results;
}

export function realpathOr(file: string): string {
  try { return realpathSync(file); } catch { return file; }
}
