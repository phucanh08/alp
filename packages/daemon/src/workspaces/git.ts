import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ERROR, RPC_ERROR, WORKSPACE_GIT, blockedFilePath } from '@anhlp/alp-protocol';
import type { GitChange, GitCompare, GitDiffFile, GitDiffPage, GitFacts, GitStatus, GitStatusFile } from '@anhlp/alp-protocol';
import { FileAccessError, likelyBinary, readConfinedFile, relativeSegments } from './files.ts';
import { IgnoreUnknown, resolveGit } from './gitignore.ts';
import { RegistryError } from './registry.ts';
import { RpcError } from '../rpc/rpc-error.ts';
import { FIXED, GIT_READ, GitReadFailed, failed, gitFailed, runGit } from './git-process.ts';
export { GIT_READ, GitReadFailed, gitReadsRunning } from './git-process.ts';
import { type Located, type Repository, boxFor, hash, locate, missing, sameConfig, scrubRemoteUrl, statMark, validBranchName } from './git-repository.ts';
export { validBranchName, scrubRemoteUrl } from './git-repository.ts';
import { type CursorBody, DECODER, type Entry, GITLINK, PAGE_BYTES, SYMLINK, ZERO, addedHunks, cursorScope, headerOf, holdsKey, parseRaw, parseSection, sectionsOf, sized } from './git-patch.ts';

/**
 * `workspace.git.status` and `workspace.git.diff` (docs/protocol/alp-json-rpc-v1.md §12.5): the
 * read-only Git state of a registry workspace, for Paseo's branch header and Changes panel.
 *
 * The workspace and its repository configuration are not trusted, so Git runs boxed in:
 * - the Git found on the absolute PATH entries outside the workspace, by its real path
 *   (gitignore.ts resolveGit), spawned with an argument list, no shell, in the workspace's real
 *   path, its own process group killed at the call's deadline;
 * - GIT_DIR and GIT_WORK_TREE set by alpd to the repository it checked (the workspace's `.git`,
 *   validated as the registry validates worktrees: core repositoryIdentity), every other GIT_*
 *   variable of alpd's dropped, no system or global configuration, no optional locks, no prompts,
 *   no lazy fetch, no replace objects, PATH without the workspace's entries;
 * - configuration overrides so nothing the repository names runs: no fsmonitor, hooks to the null
 *   device, no pager, no colour, no external diff or textconv (flags too), every
 *   filter.<driver>.{clean,smudge,process} the repository's configuration names emptied and
 *   `required` false, no submodule recursion (`--ignore-submodules=dirty`: a gitlink's recorded
 *   commit only, never a Git run inside it), no network protocol, `diff.autoRefreshIndex` off (a
 *   porcelain `git diff` would otherwise rewrite the index even with GIT_OPTIONAL_LOCKS=0);
 * - `--literal-pathspecs`: a path is never pathspec magic, and always after `--`; a base branch is
 *   a validated name resolved only as `refs/remotes/origin/<name>` then `refs/heads/<name>` with
 *   `rev-parse --verify --end-of-options`, never a revision expression;
 * - every output read as a stream with a bound; at most GIT_READ.maxConcurrent Git processes at
 *   once in alpd.
 * Content alpd shows is checked first: both sides of every file are scanned for a private key
 * (files.ts PRIVATE_KEY), historical and deleted ones included; untracked files are read by alpd
 * itself, confined as workspace.files.read confines a read. Errors carry fixed messages; the
 * cause is logged, never answered.
 *
 * `workspace.git.facts` reads in the same box for an owner's host directory that need not be a
 * registry workspace (a project-only, preflight or nested folder): its repository's root, branch,
 * HEAD, origin and whether anything changed, never a file list or content.
 */

// ---- The service ----

export type GitReaderOptions = {
  /** Resolves a workspaceId for status and diff; without it they are unavailable (facts needs none). */
  registry?: { resolve(workspaceId: string): Promise<string> };
  /** Which git: a name looked up on PATH (outside the workspace), or an absolute path (tests). */
  binary?: string;
  timeoutMs?: number;
  log?: (message: string, fields: Record<string, unknown>) => void;
  /** Tests only: called after a window's contents were scanned and before Git writes their patch, where a racing writer could change a file. */
  probe?: (step: 'scanned') => Promise<void> | void;
  /** Tests only: how an untracked path's ancestor directories are inspected (default async lstat), to inject its failures. */
  inspect?: (file: string) => Stats | Promise<Stats>;
};

type DiffParams = { workspaceId: string; compare: GitCompare; path?: string; cursor?: string };

/** What one ancestor directory of an untracked path is, as lstat saw it once in a listing. */
type Ancestor = 'directory' | 'link' | 'uninspectable';

/**
 * An untracked path Git listed, cut at its first linked directory: Git for Windows descends
 * into an untracked junction (or directory symlink) as a folder and lists what lies behind it,
 * even outside the work tree. As on POSIX, the link itself is the entry; nothing behind it is.
 *
 * Fails closed: an ancestor lstat cannot inspect, or that is neither a directory nor a link
 * (changed since Git listed it), answers `undefined` and the caller omits the entry, as it
 * omits everything else under that ancestor. Only a directory lstat saw is passed through.
 *
 * `ancestors` caches each ancestor's answer for one listing, so a directory replaced by a
 * junction during that listing keeps its earlier answer. That race is inherent (Git itself
 * may have listed before or after the swap), it only concerns the names Git listed in that
 * window, and every content read still goes through readConfinedFile, which refuses a path
 * whose directories are linked at read time.
 */
async function untrackedEntry(root: string, name: string, ancestors: Map<string, Ancestor>, inspect: (file: string) => Stats | Promise<Stats>, deadline: number): Promise<string | undefined> {
  const segments = name.split('/');
  for (let count = 1; count < segments.length; count++) {
    if (Date.now() >= deadline) throw new GitReadFailed('timed out');
    const prefix = segments.slice(0, count).join('/');
    let ancestor = ancestors.get(prefix);
    if (ancestor === undefined) {
      // Keep earlier answers stable; do not evict and re-inspect a swapped link.
      if (ancestors.size >= GIT_READ.maxAncestors) throw new GitReadFailed('ancestor cache over its bound');
      try {
        const info = await inspect(path.join(root, ...segments.slice(0, count)));
        ancestor = info.isSymbolicLink() ? 'link' : info.isDirectory() ? 'directory' : 'uninspectable';
      } catch {
        ancestor = 'uninspectable';
      }
      if (Date.now() >= deadline) throw new GitReadFailed('timed out');
      ancestors.set(prefix, ancestor);
    }
    if (ancestor === 'link') return prefix;
    if (ancestor === 'uninspectable') return undefined;
  }
  return name;
}

export function createGitReader({ registry, binary = 'git', timeoutMs = GIT_READ.timeoutMs, log = () => {}, probe, inspect = lstat }: GitReaderOptions) {
  const key = randomBytes(32);
  const mac = (scope: string) => createHmac('sha256', key).update(scope).digest('base64url').slice(0, 32);

  /** The workspace's real path, or the registry's refusal (its messages are fixed). */
  async function workspaceRoot(workspaceId: unknown): Promise<string> {
    if (typeof workspaceId !== 'string' || !workspaceId) throw new RpcError(RPC_ERROR.invalidParams, 'workspaceId is required', { reason: 'invalid_params' });
    if (!registry) throw new RpcError(ERROR.unavailable, FIXED.noRegistry);
    try {
      return await registry.resolve(workspaceId);
    } catch (error) {
      if (error instanceof RegistryError) throw new RpcError(error.code, error.message, error.data);
      if (missing(error)) throw new RpcError(ERROR.notFound, FIXED.notFound, { reason: 'not_found' });
      throw error;
    }
  }

  async function open(workspaceId: unknown): Promise<{ state: 'not_repository' | 'unsupported' } | { state: 'repository'; repo: Repository }> {
    const root = await workspaceRoot(workspaceId);
    const deadline = Date.now() + timeoutMs;
    const located = await locate(root);
    if (located.kind !== 'repository') return { state: located.kind };
    let git: string | undefined;
    try { git = resolveGit(binary, undefined, root); } catch (error) { if (error instanceof IgnoreUnknown) failed('the workspace cannot be examined'); throw error; }
    if (!git) throw new RpcError(ERROR.unavailable, FIXED.unavailable, { reason: 'git_unavailable' });
    const repo = await boxFor(located, git, deadline);
    return repo === 'unsupported' ? { state: 'unsupported' } : { state: 'repository', repo };
  }

  /** The commit an exact full ref names, or undefined. */
  async function commitOf(repo: Repository, ref: string): Promise<string | undefined> {
    const { stdout, code } = await runGit(repo, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`], { okCodes: [0, 1, 128] });
    const oid = stdout.toString('utf8').trim();
    return code === 0 && /^[0-9a-f]{40,64}$/.test(oid) ? oid : undefined;
  }

  /** A base branch resolved as origin's copy, else the local branch: its full ref and commit. */
  async function resolveBase(repo: Repository, name: string): Promise<{ ref: string; oid: string } | undefined> {
    for (const ref of [`refs/remotes/origin/${name}`, `refs/heads/${name}`]) {
      const oid = await commitOf(repo, ref);
      if (oid) return { ref, oid };
    }
    return undefined;
  }

  /** The default base branch: origin's HEAD, else main, else master (local or origin's). */
  async function defaultBase(repo: Repository): Promise<string | null> {
    const candidates = ['refs/remotes/origin/HEAD', 'refs/heads/main', 'refs/remotes/origin/main', 'refs/heads/master', 'refs/remotes/origin/master'];
    const { stdout } = await runGit(repo, ['for-each-ref', '--format=%(refname)%00%(symref)', '--', ...candidates]);
    const found = new Map<string, string>();
    for (const line of stdout.toString('utf8').split('\n')) {
      const [ref, symref = ''] = line.split('\0');
      if (ref && candidates.includes(ref)) found.set(ref, symref);
    }
    const remoteHead = found.get('refs/remotes/origin/HEAD');
    if (remoteHead?.startsWith('refs/remotes/origin/')) {
      const name = remoteHead.slice('refs/remotes/origin/'.length);
      if (validBranchName(name)) return name;
    }
    for (const name of ['main', 'master']) if (found.has(`refs/heads/${name}`) || found.has(`refs/remotes/origin/${name}`)) return name;
    return null;
  }

  const emptyStatus = (state: GitStatus['state']): GitStatus => ({
    state, ...(state === 'unsupported' ? { reason: 'not_repository_root' } : {}), branch: null, detached: false, head: null, upstream: null, baseRef: null,
    aheadBehind: null, hasRemote: false, remoteUrl: null, dirty: false, files: [], hiddenCount: 0, truncated: false, snapshot: '',
  });

  async function status(workspaceId: unknown): Promise<GitStatus> {
    const opened = await open(workspaceId);
    if (opened.state !== 'repository') return emptyStatus(opened.state);
    const { repo } = opened;
    const files: GitStatusFile[] = [];
    let hiddenCount = 0;
    let truncated = false;
    let dirty = false;
    const branch: { oid?: string; head?: string; upstream?: string; ab?: [number, number] } = {};
    const digest = createHash('sha256');
    let pending = '';
    let pendingRename: string[] | undefined;
    const ancestors = new Map<string, Ancestor>();
    const collapsed = new Set<string>();
    const take = (row: GitStatusFile) => {
      dirty = true;
      if (blockedFilePath(row.path) || (row.oldPath && blockedFilePath(row.oldPath)) || [...row.path].length > 4096 || [...(row.oldPath ?? '')].length > 4096) { hiddenCount++; return false; }
      if (files.length >= WORKSPACE_GIT.maxStatusFiles) { truncated = true; return true; }
      files.push(row);
      return false;
    };
    const record = async (field: string): Promise<boolean> => {
      if (pendingRename) {
        const [kind, xy] = pendingRename;
        pendingRename = undefined;
        return take({ path: kind!, oldPath: field, change: xy!.includes('C') ? 'copied' : 'renamed', staged: xy![0] !== '.', unstaged: xy![1] !== '.' });
      }
      if (field.startsWith('# ')) {
        const [name, ...rest] = field.slice(2).split(' ');
        const value = rest.join(' ');
        if (name === 'branch.oid') branch.oid = value;
        else if (name === 'branch.head') branch.head = value;
        else if (name === 'branch.upstream') branch.upstream = value;
        else if (name === 'branch.ab') { const ab = /^\+(\d+) -(\d+)$/.exec(value); if (ab) branch.ab = [Number(ab[1]), Number(ab[2])]; }
        return false;
      }
      const kind = field[0];
      if (kind === '1' || kind === '2' || kind === 'u') {
        const parts = field.split(' ');
        const count = kind === '1' ? 8 : kind === '2' ? 9 : 10;
        const xy = parts[1] ?? '..';
        const rowPath = parts.slice(count).join(' ');
        if (!rowPath) failed('unexpected status');
        if (kind === '2') { pendingRename = [rowPath, xy]; return false; }
        if (kind === 'u') return take({ path: rowPath, change: 'conflicted', staged: true, unstaged: true });
        const [x, y] = [xy[0], xy[1]];
        const change: GitChange = x === 'A' ? 'added' : x === 'D' || y === 'D' ? 'deleted' : x === 'T' || y === 'T' ? 'typechange' : 'modified';
        return take({ path: rowPath, change, staged: x !== '.', unstaged: y !== '.' });
      }
      if (kind === '?') {
        const listed = field.slice(2).replace(/\/$/, '');
        if (!listed) return false;
        const rowPath = await untrackedEntry(repo.root, listed, ancestors, inspect, repo.deadline);
        // Behind an ancestor that cannot be inspected: something is untracked, nothing is listed.
        if (rowPath === undefined) { dirty = true; return false; }
        if (rowPath !== listed) { if (collapsed.has(rowPath)) return false; collapsed.add(rowPath); }
        return take({ path: rowPath, change: 'untracked', staged: false, unstaged: true });
      }
      if (kind === '!') return false;
      failed('unexpected status');
      return false;
    };
    let seen = 0;
    const { stopped } = await runGit(repo, ['status', '--porcelain=v2', '-z', '--branch', '--ahead-behind', '--untracked-files=all', '--ignored=no', '--ignore-submodules=dirty', '--find-renames'], {
      onData: async chunk => {
        seen += chunk.length;
        digest.update(chunk);
        const fields = (pending + chunk.toString('utf8')).split('\0');
        pending = fields.pop()!;
        for (const field of fields) if (field && await record(field)) return true;
        if (seen > GIT_READ.maxListBytes) { truncated = true; return true; }
        return false;
      },
    });
    if (!stopped && pending) failed('unterminated status');
    const head = branch.oid && /^[0-9a-f]{40,64}$/.test(branch.oid) ? branch.oid : null;
    const detached = branch.head === '(detached)';
    const current = !detached && branch.head && validBranchName(branch.head) ? branch.head : null;
    const upstream = current && branch.upstream && branch.ab ? { ref: branch.upstream, ahead: branch.ab[0], behind: branch.ab[1] } : null;
    const baseRef = await defaultBase(repo);
    let aheadBehind: GitStatus['aheadBehind'] = null;
    if (baseRef && current && current !== baseRef && head) {
      const base = await resolveBase(repo, baseRef);
      if (base) {
        const { stdout } = await runGit(repo, ['rev-list', '--left-right', '--count', '--end-of-options', `${base.oid}...${head}`], { okCodes: [0, 128] });
        const counts = stdout.toString('utf8').trim().split(/\s+/).map(Number);
        if (counts.length === 2 && counts.every(Number.isSafeInteger)) aheadBehind = { behind: counts[0]!, ahead: counts[1]! };
      }
    }
    digest.update(await statMark(path.join(repo.gitDir, 'index')));
    await sameConfig(repo);
    return {
      state: 'repository', branch: current, detached, head, upstream, baseRef, aheadBehind, hasRemote: repo.remoteUrl !== null,
      remoteUrl: scrubRemoteUrl(repo.remoteUrl), dirty, files, hiddenCount, truncated, snapshot: `s1.${digest.digest('hex').slice(0, 40)}`,
    };
  }

  /**
   * The directory workspace.git.facts is asked about, as its real path: absolute, already
   * normalised (no empty, `.` or `..` segment, no trailing separator), and a directory.
   */
  async function requestedDirectory(directory: unknown): Promise<string> {
    const invalid = () => new RpcError(RPC_ERROR.invalidParams, FIXED.invalidDirectory, { reason: 'invalid_path' });
    if (typeof directory !== 'string' || !directory || [...directory].length > 4096 || directory.includes('\0')) throw invalid();
    if (!path.isAbsolute(directory) || path.normalize(directory) !== directory) throw invalid();
    const { root } = path.parse(directory);
    const rest = directory.slice(root.length);
    if (rest && rest.split(/[\\/]/).some(segment => segment === '' || segment === '.' || segment === '..')) throw invalid();
    const absent = () => new RpcError(ERROR.notFound, FIXED.noDirectory, { reason: 'not_found' });
    let real: string;
    try { real = await realpath(directory); } catch (error) { if (missing(error)) throw absent(); throw error; }
    let info;
    try { info = await stat(real); } catch (error) { if (missing(error)) throw absent(); throw error; }
    if (!info.isDirectory()) throw new RpcError(ERROR.notFound, FIXED.notDirectory, { reason: 'not_directory' });
    return real;
  }

  /**
   * workspace.git.facts: what the directory's checkout is, each answer explicit. Its repository's
   * top level (`ok`), a folder inside one (`not_repository_root`, the enclosing repository's
   * facts), no `.git` at or above it (`unknown`, before any Git runs), or a repository alpd does
   * not read (`unsupported`). One porcelain status, stopped at its first change row.
   */
  async function facts(directory: unknown): Promise<GitFacts> {
    const real = await requestedDirectory(directory);
    const deadline = Date.now() + timeoutMs;
    let located = await locate(real);
    if (located.kind === 'not_repository') return { kind: 'unknown' };
    let kind: 'ok' | 'not_repository_root' = 'ok';
    if (located.kind === 'unsupported') {
      // Inside a .git directory is no work tree of the repository above it.
      if (path.relative(located.top, real).split(path.sep).includes('.git')) return { kind: 'unsupported', reason: 'inside_git_dir' };
      located = await locate(located.top);
      if (located.kind !== 'repository') failed('the enclosing repository changed during the read');
      kind = 'not_repository_root';
    }
    const found = located as Extract<Located, { kind: 'repository' }>;
    let git: string | undefined;
    try { git = resolveGit(binary, undefined, found.root); } catch (error) { if (error instanceof IgnoreUnknown) failed('the directory cannot be examined'); throw error; }
    if (!git) throw new RpcError(ERROR.unavailable, FIXED.unavailable, { reason: 'git_unavailable' });
    const repo = await boxFor(found, git, deadline);
    if (repo === 'unsupported') return { kind: 'unsupported', reason: 'worktree_elsewhere' };
    const branch: { oid?: string; head?: string } = {};
    let dirty = false;
    let pending = '';
    const { stopped } = await runGit(repo, ['status', '--porcelain=v2', '-z', '--branch', '--no-ahead-behind', '--untracked-files=all', '--ignored=no', '--ignore-submodules=dirty'], {
      onData: chunk => {
        const fields = (pending + chunk.toString('utf8')).split('\0');
        pending = fields.pop()!;
        for (const field of fields) {
          if (!field) continue;
          if (!field.startsWith('# ')) { dirty = true; return true; }
          const [name, ...rest] = field.slice(2).split(' ');
          if (name === 'branch.oid') branch.oid = rest.join(' ');
          else if (name === 'branch.head') branch.head = rest.join(' ');
        }
        // Headers come first: a row begun is a change, however long its path.
        if (pending && !pending.startsWith('#')) { dirty = true; return true; }
        if (pending.length > 64 * 1024) failed('status header over its bound');
        return false;
      },
    });
    if (!stopped && pending) failed('unterminated status');
    await sameConfig(repo);
    const detached = branch.head === '(detached)';
    return {
      kind, repoRoot: repo.root, branch: !detached && branch.head && validBranchName(branch.head) ? branch.head : null, detached,
      head: branch.oid && /^[0-9a-f]{40,64}$/.test(branch.oid) ? branch.oid : null,
      hasRemote: repo.remoteUrl !== null, remoteUrl: scrubRemoteUrl(repo.remoteUrl), dirty,
    };
  }

  /** The untracked files Git does not ignore, at most `limit` that are not blocked (more: `more`). */
  async function untrackedOf(repo: Repository, relative: string | undefined, limit: number) {
    const found: string[] = [];
    let hidden = 0;
    let more = false;
    let pending = '';
    const ancestors = new Map<string, Ancestor>();
    const collapsed = new Set<string>();
    const { stopped } = await runGit(repo, ['ls-files', '-z', '--others', '--exclude-standard', '--', ...(relative ? [relative] : [])], {
      onData: async chunk => {
        const fields = (pending + chunk.toString('utf8')).split('\0');
        pending = fields.pop()!;
        for (const listed of fields) {
          // A nested repository is listed as its directory: not a file.
          if (!listed || listed.endsWith('/')) continue;
          const name = await untrackedEntry(repo.root, listed, ancestors, inspect, repo.deadline);
          // Behind an ancestor that cannot be inspected: omitted, also when asked for by path.
          if (name === undefined) continue;
          if (name !== listed) { if (collapsed.has(name)) continue; collapsed.add(name); }
          if (relative && name !== relative) continue;
          if (blockedFilePath(name) || [...name].length > 4096) { hidden++; continue; }
          if (found.length >= limit) { more = true; return true; }
          found.push(name);
        }
        return false;
      },
    });
    if (!stopped && pending) failed('unterminated untracked list');
    return { found, hidden, more };
  }

  async function diff(params: DiffParams): Promise<GitDiffPage> {
    const { workspaceId, compare, path: relative, cursor } = params ?? ({} as DiffParams);
    const mode = compare?.mode;
    if (!['uncommitted', 'staged', 'unstaged', 'base'].includes(mode)) throw new RpcError(RPC_ERROR.invalidParams, 'compare.mode is not one alpd knows', { reason: 'invalid_compare' });
    if (compare.baseRef !== undefined && (mode !== 'base' || !validBranchName(compare.baseRef))) throw new RpcError(RPC_ERROR.invalidParams, FIXED.invalidCompare, { reason: 'invalid_compare' });
    if (relative !== undefined) {
      try { relativeSegments(relative); } catch (error) {
        if (error instanceof FileAccessError) throw new RpcError(error.code, error.message, { reason: error.reason });
        throw error;
      }
    }
    let body: CursorBody | undefined;
    if (cursor !== undefined) {
      const match = typeof cursor === 'string' ? /^c1\.(\d{1,9})\.(s1\.[0-9a-f]{40})\.([A-Za-z0-9_-]{32})$/.exec(cursor) : null;
      if (!match) throw new RpcError(RPC_ERROR.invalidParams, FIXED.invalidCursor, { reason: 'invalid_cursor' });
      body = { offset: Number(match[1]), snapshot: match[2]! };
      const expected = Buffer.from(mac(cursorScope(workspaceId, compare, relative, body)));
      if (!timingSafeEqual(expected, Buffer.from(match[3]!))) throw new RpcError(RPC_ERROR.invalidParams, FIXED.invalidCursor, { reason: 'invalid_cursor' });
    }
    const ignoreWhitespace = compare.ignoreWhitespace === true;
    const opened = await open(workspaceId);
    if (opened.state !== 'repository') throw new RpcError(ERROR.notFound, opened.state === 'unsupported' ? FIXED.notRoot : FIXED.notRepository, { reason: 'not_repository' });
    const { repo } = opened;
    const head = await commitOf(repo, 'HEAD');
    const done = (files: GitDiffFile[], hiddenCount: number, snapshot: string, extra: { baseRef?: string; truncated?: boolean; nextCursor?: string } = {}): GitDiffPage => ({
      compare: { mode, ...(extra.baseRef ? { baseRef: extra.baseRef } : {}), ignoreWhitespace }, snapshot, files, hiddenCount,
      truncated: extra.truncated ?? false, ...(extra.nextCursor ? { nextCursor: extra.nextCursor } : {}),
    });

    // What is compared.
    let range: string[];
    let baseRef: string | undefined;
    const marks: string[] = [mode, head ?? '-'];
    if (mode === 'base') {
      baseRef = compare.baseRef ?? (await defaultBase(repo)) ?? undefined;
      const base = baseRef ? await resolveBase(repo, baseRef) : undefined;
      if (compare.baseRef && !base) throw new RpcError(ERROR.notFound, FIXED.unknownRef, { reason: 'unknown_ref' });
      const mergeBase = base && head ? (await runGit(repo, ['merge-base', '--end-of-options', base.oid, head], { okCodes: [0, 1] })).stdout.toString('utf8').trim() : '';
      marks.push(baseRef ?? '-', base?.oid ?? '-', mergeBase || '-');
      if (!/^[0-9a-f]{40,64}$/.test(mergeBase)) {
        // No base branch, no commit yet, or unrelated histories: nothing committed to compare.
        const snapshot = `s1.${hash(...marks).slice(0, 40)}`;
        if (body && body.snapshot !== snapshot) throw new RpcError(ERROR.conflict, FIXED.stale, { reason: 'stale_snapshot' });
        return done([], 0, snapshot, { baseRef });
      }
      range = [mergeBase, head!];
    } else if (mode === 'staged') {
      range = ['--cached', head ?? repo.emptyTree];
    } else if (mode === 'uncommitted') {
      range = [head ?? repo.emptyTree];
    } else {
      range = [];
    }
    const diffFlags = ['--no-color', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', '--submodule=short'];
    const listed = await runGit(repo, ['diff', '--raw', '-z', '--no-abbrev', '-M', ...diffFlags, ...range, '--']);
    const all = parseRaw(listed.stdout);
    const worktree = mode === 'uncommitted' || mode === 'unstaged';
    const untracked = worktree ? await untrackedOf(repo, relative, WORKSPACE_GIT.maxUntracked) : { found: [], hidden: 0, more: false };

    // The snapshot: HEAD (and the base), the index, the change list, the untracked files, and the
    // work tree files compared (their identity, size and times).
    marks.push(hash(listed.stdout), untracked.found.join('\0'), String(untracked.more));
    if (mode !== 'base') marks.push(await statMark(path.join(repo.gitDir, 'index')));
    if (worktree) {
      const files = [...all.filter(entry => entry.dstMode !== '000000' && ZERO.test(entry.dstOid)).map(entry => entry.path), ...untracked.found].slice(0, GIT_READ.maxSnapshotStats);
      for (const file of files) marks.push(file, await statMark(path.join(repo.root, ...file.split('/'))));
    }
    const snapshot = `s1.${hash(...marks).slice(0, 40)}`;
    if (body && body.snapshot !== snapshot) throw new RpcError(ERROR.conflict, FIXED.stale, { reason: 'stale_snapshot' });

    // What may be shown: never a blocked path on either side; with `path`, that file only.
    let hiddenCount = untracked.hidden;
    const entries: Entry[] = [];
    for (const entry of all) {
      if (relative !== undefined && entry.path !== relative && entry.oldPath !== relative) continue;
      if (blockedFilePath(entry.path) || (entry.oldPath && blockedFilePath(entry.oldPath)) || [...entry.path].length > 4096 || [...(entry.oldPath ?? '')].length > 4096) { hiddenCount++; continue; }
      entries.push(entry);
    }
    for (const name of untracked.found) entries.push({ path: name, change: 'untracked', srcMode: '000000', dstMode: '100644', srcOid: '', dstOid: '', untracked: true });
    const offset = body?.offset ?? 0;
    if (offset > entries.length) throw new RpcError(RPC_ERROR.invalidParams, FIXED.invalidCursor, { reason: 'invalid_cursor' });

    const files: GitDiffFile[] = [];
    let used = 0;
    let next: number | undefined;
    for (let start = offset; start < entries.length && next === undefined;) {
      const window = await windowOf(repo, entries, start, mode);
      const results = await diffWindow(repo, window.entries, mode, range, diffFlags, ignoreWhitespace);
      for (let index = 0; index < results.length; index++) {
        const result = results[index];
        if (result === undefined) continue; // no content change (a file only touched)
        const cost = result.cost;
        if (files.length && used + cost > PAGE_BYTES) { next = start + index; break; }
        used += cost;
        files.push(result.file);
      }
      start += window.entries.length;
    }
    await sameConfig(repo);
    const nextCursor = next === undefined ? undefined : (() => {
      const nextBody = { offset: next, snapshot };
      return `c1.${next}.${snapshot}.${mac(cursorScope(workspaceId, compare, relative, nextBody))}`;
    })();
    return done(files, hiddenCount, snapshot, { baseRef, truncated: next !== undefined || untracked.more, nextCursor });
  }

  type Side = { oid: string } | { file: string } | undefined;
  type Planned = Entry & { old: Side; new: Side; sizes: [number, number] };

  /** The entries from `start` whose content one window reads: GIT_READ.windowFiles, GIT_READ.windowBytes (at least one). */
  async function windowOf(repo: Repository, entries: Entry[], start: number, mode: GitCompare['mode']): Promise<{ entries: Planned[] }> {
    const candidates = entries.slice(start, start + GIT_READ.windowFiles).map((entry): Planned => {
      const special = entry.srcMode === GITLINK || entry.dstMode === GITLINK || entry.srcMode === SYMLINK || entry.dstMode === SYMLINK || entry.untracked || (entry.conflicted && mode === 'staged');
      const old: Side = special || ZERO.test(entry.srcMode) ? undefined : { oid: entry.srcOid };
      const now: Side = special || ZERO.test(entry.dstMode) ? undefined : ZERO.test(entry.dstOid) ? { file: entry.path } : { oid: entry.dstOid };
      return { ...entry, old, new: now, sizes: [0, 0] };
    });
    const oids = [...new Set(candidates.flatMap(entry => [entry.old, entry.new]).flatMap(side => side && 'oid' in side ? [side.oid] : []))];
    const sizes = new Map<string, number>();
    if (oids.length) {
      const { stdout } = await runGit(repo, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { stdin: `${oids.join('\n')}\n` });
      for (const line of stdout.toString('utf8').split('\n')) {
        const [oid, type, size] = line.split(' ');
        if (oid && type === 'blob' && size !== undefined) sizes.set(oid, Number(size));
      }
    }
    const sizeOf = async (side: Side) => {
      if (!side) return 0;
      if ('oid' in side) return sizes.get(side.oid) ?? Number.MAX_SAFE_INTEGER;
      try { return Number((await lstat(path.join(repo.root, ...side.file.split('/')))).size); } catch { return 0; }
    };
    const chosen: Planned[] = [];
    let total = 0;
    for (const entry of candidates) {
      entry.sizes = [await sizeOf(entry.old), await sizeOf(entry.new)];
      if (entry.untracked) entry.sizes = [0, await sizeOf({ file: entry.path })];
      // A side over the scan bound is not read: the file is too_large.
      const reads = entry.sizes.reduce((sum, size) => sum + (size > GIT_READ.maxScanBytes ? 0 : size), 0);
      if (chosen.length && total + reads > GIT_READ.windowBytes) break;
      total += reads;
      chosen.push(entry);
    }
    return { entries: chosen };
  }

  /** Blob contents by id, each at most GIT_READ.maxScanBytes as batch-check sized them (`bytes` in all). */
  async function blobs(repo: Repository, oids: string[], bytes: number): Promise<Map<string, Buffer>> {
    const contents = new Map<string, Buffer>();
    if (!oids.length) return contents;
    const { stdout } = await runGit(repo, ['cat-file', '--batch'], { stdin: `${oids.join('\n')}\n`, maxBytes: bytes + oids.length * 200 + 1024 });
    let at = 0;
    while (at < stdout.length) {
      const newline = stdout.indexOf(10, at);
      if (newline < 0) failed('unterminated object');
      const [oid, type, size] = stdout.subarray(at, newline).toString('utf8').split(' ');
      at = newline + 1;
      if (type === 'missing' || size === undefined) continue;
      const length = Number(size);
      if (!Number.isSafeInteger(length) || at + length > stdout.length) failed('unexpected object');
      contents.set(oid!, stdout.subarray(at, at + length));
      at += length + 1;
    }
    return contents;
  }

  type Result = { file: GitDiffFile; cost: number } | undefined;

  async function diffWindow(repo: Repository, planned: Planned[], mode: GitCompare['mode'], range: string[], diffFlags: string[], ignoreWhitespace: boolean): Promise<Result[]> {
    const shown = (entry: Entry, kind: GitDiffFile['kind'], extra: Partial<GitDiffFile> = {}): Result => sized({ path: entry.path, ...(entry.oldPath ? { oldPath: entry.oldPath } : {}), change: entry.change, kind, additions: 0, deletions: 0, hunks: [], ...extra });
    const readable = (size: number) => size <= GIT_READ.maxScanBytes;
    const wanted = new Map<string, number>();
    for (const entry of planned) {
      for (const [side, size] of [[entry.old, entry.sizes[0]], [entry.new, entry.sizes[1]]] as const) if (side && 'oid' in side && readable(size)) wanted.set(side.oid, size);
    }
    const contents = await blobs(repo, [...wanted.keys()], [...wanted.values()].reduce((sum, size) => sum + size, 0));
    const results: Result[] = new Array(planned.length).fill(undefined);
    const patched: Array<{ index: number; entry: Planned; group: 'plain' | 'renamed' | 'ours' }> = [];
    /** The digest of each work tree side as scanned: Git reads the file again for the patch. */
    const scanned = new Map<string, string>();
    for (const [index, entry] of planned.entries()) {
      if (entry.srcMode === GITLINK || entry.dstMode === GITLINK) { results[index] = shown(entry, 'submodule'); continue; }
      if (entry.srcMode === SYMLINK || entry.dstMode === SYMLINK) { results[index] = shown(entry, 'symlink'); continue; }
      if (entry.untracked) { results[index] = await untrackedFile(repo, entry, shown); continue; }
      if (entry.conflicted && mode === 'staged') { results[index] = shown(entry, 'text'); continue; }
      if (entry.sizes.some(size => !readable(size))) { results[index] = shown(entry, 'too_large'); continue; }
      const sides: Buffer[] = [];
      let refused = false;
      for (const side of [entry.old, entry.new]) {
        if (!side) continue;
        if ('oid' in side) { const bytes = contents.get(side.oid); if (bytes) sides.push(bytes); else refused = true; continue; }
        try {
          const bytes = await readConfinedFile(repo.root, side.file.split('/'), side.file, GIT_READ.maxScanBytes);
          if (bytes === 'too_large') { results[index] = shown(entry, 'too_large'); refused = true; break; }
          scanned.set(side.file, hash(bytes));
          sides.push(bytes);
        } catch {
          // A link on the way, a second name, a change while read, gone: not shown.
          refused = true;
        }
      }
      if (results[index]) continue;
      if (refused || sides.some(holdsKey)) { results[index] = shown(entry, 'withheld'); continue; }
      if (sides.some(likelyBinary)) { results[index] = shown(entry, 'binary'); continue; }
      patched.push({ index, entry, group: entry.conflicted ? 'ours' : entry.oldPath ? 'renamed' : 'plain' });
    }
    if (patched.length) await probe?.('scanned');
    for (const group of ['plain', 'renamed', 'ours'] as const) {
      const members = patched.filter(item => item.group === group);
      // Command lines stay bounded: the paths go in chunks.
      for (let from = 0; from < members.length;) {
        const chunk: typeof members = [];
        let bytes = 0;
        while (from < members.length && (chunk.length === 0 || bytes < GIT_READ.maxArgBytes)) {
          const item = members[from++]!;
          bytes += Buffer.byteLength(item.entry.path) + Buffer.byteLength(item.entry.oldPath ?? '') + 2;
          chunk.push(item);
        }
        const flags = [...diffFlags, '-p', '-U3', '--inter-hunk-context=0', '--src-prefix=a/', '--dst-prefix=b/', group === 'renamed' ? '-M' : '--no-renames', ...(ignoreWhitespace ? ['-w'] : [])];
        const args = group === 'ours' ? ['diff', '-2', ...flags, '--'] : ['diff', ...flags, ...range, '--'];
        const stream = sectionsOf(WORKSPACE_GIT.maxFileBytes);
        await runGit(repo, [...args, ...chunk.flatMap(item => item.entry.oldPath ? [item.entry.oldPath, item.entry.path] : [item.entry.path])], { onData: data => { stream.write(data); } });
        stream.end();
        const byHeader = new Map(chunk.map(item => [headerOf(item.entry), item]));
        const seen = new Set<string>();
        for (const section of stream.sections) {
          const item = byHeader.get(section.header);
          // A section Git gave for no file asked, or twice: its pairing is not the list's.
          if (!item || seen.has(section.header)) failed('a patch section for no listed file');
          seen.add(section.header);
          if (section.bytes > WORKSPACE_GIT.maxFileBytes) { results[item!.index] = shown(item!.entry, 'too_large'); continue; }
          // The scan above read the content; Git read it again for this patch. A work tree file
          // that changed in between, or a patch that shows a key, is withheld.
          if (holdsKey(Buffer.concat(section.chunks)) || !(await unchanged(repo, item!.entry, scanned))) { results[item!.index] = shown(item!.entry, 'withheld'); continue; }
          const parsed = parseSection(section);
          results[item!.index] = parsed.binary
            ? shown(item!.entry, 'binary')
            : shown(item!.entry, 'text', { additions: parsed.additions, deletions: parsed.deletions, hunks: parsed.hunks });
        }
        // A file Git listed but gave no section for has no content change (its stat only changed).
      }
    }
    return results;
  }

  /** Whether the entry's work tree side still has the content scanned before its patch (none: nothing to check). */
  async function unchanged(repo: Repository, entry: Planned, scanned: Map<string, string>): Promise<boolean> {
    const side = entry.new;
    if (!side || !('file' in side)) return true;
    const before = scanned.get(side.file);
    if (before === undefined) return false;
    try {
      const bytes = await readConfinedFile(repo.root, side.file.split('/'), side.file, GIT_READ.maxScanBytes);
      return bytes !== 'too_large' && hash(bytes) === before;
    } catch {
      return false;
    }
  }

  async function untrackedFile(repo: Repository, entry: Entry, shown: (entry: Entry, kind: GitDiffFile['kind'], extra?: Partial<GitDiffFile>, cost?: number) => Result): Promise<Result> {
    const file = path.join(repo.root, ...entry.path.split('/'));
    let info;
    try { info = await lstat(file); } catch { return undefined; }
    if (info.isSymbolicLink()) return shown(entry, 'symlink');
    if (!info.isFile()) return undefined;
    let bytes: Buffer | 'too_large';
    try {
      bytes = await readConfinedFile(repo.root, entry.path.split('/'), entry.path, WORKSPACE_GIT.maxFileBytes);
    } catch (error) {
      if (error instanceof FileAccessError && error.reason === 'not_found') return undefined;
      return shown(entry, 'withheld');
    }
    if (bytes === 'too_large') return shown(entry, 'too_large');
    if (holdsKey(bytes)) return shown(entry, 'withheld');
    if (likelyBinary(bytes)) return shown(entry, 'binary');
    const { hunks, additions } = addedHunks(DECODER.decode(bytes));
    return shown(entry, 'text', { additions, hunks });
  }

  /** Runs a read, answering any failure that is not a refusal as `1000 git_failed` (its cause logged). */
  const guarded = <T>(method: string, run: () => Promise<T>) => run().catch(error => {
    if (error instanceof RpcError) throw error;
    log(`${method} failed`, { cause: error instanceof GitReadFailed ? error.cause : String((error as Error)?.message ?? error) });
    throw gitFailed();
  });

  return {
    status: (workspaceId: unknown) => guarded('workspace.git.status', () => status(workspaceId)),
    diff: (params: DiffParams) => guarded('workspace.git.diff', () => diff(params)),
    facts: (directory: unknown) => guarded('workspace.git.facts', () => facts(directory)),
  };
}

export type GitReader = ReturnType<typeof createGitReader>;
