import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { user_worktree } from '@anhlp/alp-core';
import { ERROR, RPC_ERROR, WORKSPACE_GIT, blockedFilePath } from '@anhlp/alp-protocol';
import type { GitChange, GitCompare, GitDiffFile, GitDiffHunk, GitDiffPage, GitStatus, GitStatusFile } from '@anhlp/alp-protocol';
import { FileAccessError, PRIVATE_KEY, likelyBinary, readConfinedFile, relativeSegments } from './files.js';
import { IgnoreUnknown, resolveGit, searchPathOutside } from './gitignore.js';
import { RegistryError } from './registry.js';
import { RpcError } from './rpc-error.js';

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
 */

export const GIT_READ = Object.freeze({
  /** One call (all of its Git processes, waiting for a turn included) gets this long. */
  timeoutMs: 15_000,
  /** Git processes these reads run at once in alpd, and processes that may wait for one. */
  maxConcurrent: 4,
  maxQueued: 32,
  maxErrorBytes: 16 * 1024,
  /** Configuration, change list and untracked list output, at most. */
  maxListBytes: 16 * 1024 * 1024,
  /** One patch stream, at most (its files are at most a window's worth of content). */
  maxPatchStreamBytes: 32 * 1024 * 1024,
  /** One side of a file scanned for a private key; a larger side is `too_large`. */
  maxScanBytes: 8 * 1024 * 1024,
  /** Files whose content one window reads and diffs together, and their content's total. */
  windowFiles: 64,
  windowBytes: 4 * 1024 * 1024,
  /** Pathspec bytes on one command line. */
  maxArgBytes: process.platform === 'win32' ? 24 * 1024 : 256 * 1024,
  /** Worktree files whose size and time enter a diff's snapshot. */
  maxSnapshotStats: 5_000,
});

const FIXED = Object.freeze({
  notRepository: 'The workspace is not a Git repository',
  notRoot: 'The workspace is not the top level of its Git repository',
  unavailable: 'No Git is available to alpd',
  tooOld: 'The Git available to alpd is older than 2.31, which these reads need',
  failed: 'Git could not read the workspace',
  invalidCompare: 'compare.baseRef must name a branch',
  unknownRef: 'compare.baseRef names no branch of the repository',
  stale: 'The checkout changed since the cursor was given; ask again without a cursor',
  invalidCursor: 'cursor is not one alpd gave for this workspace and comparison',
  notFound: 'No workspace with this workspaceId',
});

/** A Git read that failed: answered as `1000 git_failed` with a fixed message; `cause` is logged only. */
export class GitReadFailed extends Error {
  constructor(readonly cause: string) { super(FIXED.failed); }
}

const failed = (why: string): never => { throw new GitReadFailed(why); };
const gitFailed = () => new RpcError(ERROR.failed, FIXED.failed, { reason: 'git_failed' });

// ---- Git processes ----

let running = 0;
const waiting: Array<() => void> = [];
function acquire(deadline: number): Promise<() => void> {
  let released = false;
  const release = () => { if (released) return; released = true; running--; waiting.shift()?.(); };
  if (running < GIT_READ.maxConcurrent) { running++; return Promise.resolve(release); }
  if (waiting.length >= GIT_READ.maxQueued) return Promise.reject(new GitReadFailed('too many Git reads waiting'));
  return new Promise((resolve, reject) => {
    const turn = () => { clearTimeout(timer); running++; resolve(release); };
    const timer = setTimeout(() => {
      const index = waiting.indexOf(turn);
      if (index >= 0) waiting.splice(index, 1);
      reject(new GitReadFailed('timed out waiting for a turn'));
    }, Math.max(0, deadline - Date.now()));
    waiting.push(turn);
  });
}

/** Git processes these reads run now, for tests. */
export const gitReadsRunning = () => running;

type Box = { git: string; root: string; env: NodeJS.ProcessEnv; deadline: number; overrides: string[] };

/** Flags before every subcommand: nothing the repository names may run, nothing is paged or coloured. */
const BOXED = [
  '--no-pager', '--literal-pathspecs',
  '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${os.devNull}`, '-c', 'core.pager=cat', '-c', 'core.untrackedCache=false',
  '-c', 'core.quotePath=false', '-c', 'color.ui=never', '-c', 'diff.autoRefreshIndex=false', '-c', 'diff.noprefix=false',
  '-c', 'diff.mnemonicPrefix=false', '-c', 'diff.relative=false', '-c', 'diff.suppressBlankEmpty=false', '-c', `diff.orderFile=${os.devNull}`,
  '-c', 'log.showSignature=false', '-c', 'submodule.recurse=false', '-c', 'protocol.allow=never', '-c', 'maintenance.auto=false',
  '-c', 'gc.auto=0', '-c', 'status.showStash=false', '-c', 'status.renames=true', '-c', 'diff.renames=true',
];

type RunOptions = {
  stdin?: string;
  okCodes?: number[];
  /** Collect at most this much stdout; more fails (GitReadFailed). */
  maxBytes?: number;
  /** Stream stdout instead: return true to stop Git (killed; the result says `stopped`). */
  onData?: (chunk: Buffer) => boolean | void;
};

function runGit(box: Box, args: string[], { stdin, okCodes = [0], maxBytes = GIT_READ.maxListBytes, onData }: RunOptions = {}): Promise<{ code: number; stdout: Buffer; stopped: boolean }> {
  return acquire(box.deadline).then(release => new Promise((resolve, reject) => {
    let settled = false;
    let stopped = false;
    let child: ReturnType<typeof spawn>;
    const group = process.platform !== 'win32';
    const kill = () => {
      try {
        if (group && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // already gone
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      release();
      outcome();
    };
    try {
      child = spawn(box.git, [...BOXED, ...box.overrides, ...args], {
        cwd: box.root, env: box.env, shell: false, windowsHide: true, detached: group, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish(() => reject(new GitReadFailed(`spawn: ${(error as Error).message}`)));
      return;
    }
    timer = setTimeout(() => finish(() => { kill(); reject(new GitReadFailed('timed out')); }), Math.max(1, box.deadline - Date.now()));
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      if (settled || stopped) return;
      if (onData) {
        if (onData(chunk)) { stopped = true; kill(); }
        return;
      }
      outBytes += chunk.length;
      if (outBytes > maxBytes) finish(() => { kill(); reject(new GitReadFailed('output over its bound')); });
      else out.push(chunk);
    });
    child.stderr!.on('data', (chunk: Buffer) => { if (err.length < GIT_READ.maxErrorBytes) err += chunk.toString('utf8'); });
    child.on('error', error => finish(() => reject(new GitReadFailed(`spawn: ${error.message}`))));
    child.on('close', code => finish(() => {
      if (stopped) { resolve({ code: code ?? -1, stdout: Buffer.alloc(0), stopped: true }); return; }
      if (code === null || !okCodes.includes(code)) { reject(new GitReadFailed(`${args[0]} exit ${code}: ${err.trim().slice(0, 1000)}`)); return; }
      resolve({ code, stdout: Buffer.concat(out), stopped: false });
    }));
    if (stdin !== undefined) {
      child.stdin!.on('error', () => {});
      child.stdin!.end(stdin);
    }
  }));
}

/**
 * The oldest Git these reads run: `rev-parse --end-of-options` (2.30) and GIT_CONFIG_COUNT (2.31).
 * An older one would take `--end-of-options` as a revision and answer HEAD as missing: refused.
 */
const MINIMUM_GIT = [2, 31] as const;
const versions = new Map<string, Promise<boolean>>();
function recentEnough(box: Box): Promise<boolean> {
  const known = versions.get(box.git);
  if (known) return known;
  const checked = runGit(box, ['--version'], { maxBytes: 4096 }).then(({ stdout }) => {
    const found = /^git version (\d+)\.(\d+)/.exec(stdout.toString('utf8'));
    if (!found) failed('unrecognized git --version');
    const [major, minor] = [Number(found![1]), Number(found![2])];
    return major > MINIMUM_GIT[0] || (major === MINIMUM_GIT[0] && minor >= MINIMUM_GIT[1]);
  });
  versions.set(box.git, checked);
  checked.catch(() => versions.delete(box.git));
  return checked;
}

// ---- The workspace and its repository ----

type Located = { kind: 'not_repository' } | { kind: 'unsupported' } | { kind: 'repository'; root: string; gitDir: string };

const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '');

/** Whether `root` is a repository's top level, inside one (a `.git` above it), or in none. */
async function locate(root: string): Promise<Located> {
  let entry = true;
  try { await lstat(path.join(root, '.git')); } catch (error) { if (!missing(error)) failed('cannot examine .git'); entry = false; }
  if (!entry) {
    for (let directory = path.dirname(root); ; directory = path.dirname(directory)) {
      try { await lstat(path.join(directory, '.git')); return { kind: 'unsupported' }; } catch (error) { if (!missing(error)) failed('cannot examine .git above the workspace'); }
      if (path.dirname(directory) === directory) return { kind: 'not_repository' };
    }
  }
  let gitDir: string;
  try {
    // The registry's own check of a checkout: a canonical root, a real .git directory or a
    // gitdir file (one name, bounded), a linked worktree's backlink to this very .git.
    ({ gitDir } = await user_worktree.repositoryIdentity(root));
  } catch (error) {
    failed(`the workspace's .git cannot be used: ${(error as Error).message}`);
  }
  return { kind: 'repository', root, gitDir: gitDir! };
}

/** alpd's environment for Git: none of its own GIT_* variables, only those naming the checked repository. */
function environment(root: string, gitDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!/^GIT_/i.test(key) && !/^path$/i.test(key)) env[key] = value;
  let searchPath: string;
  try { searchPath = searchPathOutside(root); } catch { failed('the workspace cannot be examined'); }
  return {
    ...env, PATH: searchPath!, GIT_DIR: gitDir, GIT_WORK_TREE: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_ATTR_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_PROTOCOL_FROM_USER: '0', LC_ALL: 'C', LANG: 'C',
  };
}

const EMPTY_TREE = { sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321' };

type Repository = Box & { remoteUrl: string | null; emptyTree: string; gitDir: string };

/**
 * The box for a located repository: the configuration overrides that neutralize every filter it
 * names, origin's URL, its object format. A filter name `-c` cannot carry, or a work tree
 * configured elsewhere than the workspace, refuses (unsupported or failed), never runs Git
 * without the overrides.
 */
async function boxFor(located: Extract<Located, { kind: 'repository' }>, git: string, deadline: number): Promise<Repository | 'unsupported'> {
  const box: Box = { git, root: located.root, env: environment(located.root, located.gitDir), deadline, overrides: [] };
  if (!(await recentEnough(box))) throw new RpcError(ERROR.unavailable, FIXED.tooOld, { reason: 'git_unavailable' });
  const { stdout } = await runGit(box, ['config', '--null', '--get-regexp', '^(remote\\.origin\\.url|core\\.worktree|extensions\\.objectformat|filter\\..+\\.(smudge|clean|process|required))$'], { okCodes: [0, 1] });
  let remoteUrl: string | null = null;
  let worktree: string | undefined;
  let format = 'sha1';
  const neutral = new Set<string>();
  for (const record of stdout.toString('utf8').split('\0')) {
    if (!record) continue;
    const newline = record.indexOf('\n');
    const key = newline < 0 ? record : record.slice(0, newline);
    const value = newline < 0 ? '' : record.slice(newline + 1);
    if (key === 'remote.origin.url') remoteUrl = value;
    else if (key === 'core.worktree') worktree = value;
    else if (key === 'extensions.objectformat') format = value.toLowerCase();
    else if (key.startsWith('filter.')) {
      // `-c name=value` splits at the first '=': a driver whose name holds one cannot be emptied.
      if (key.includes('=') || /[\0\n]/.test(key)) failed('a filter driver name cannot be neutralized');
      neutral.add(key);
    }
  }
  if (worktree !== undefined) {
    // A submodule's checkout names its own work tree; any other place is not this workspace.
    const named = await realpath(path.resolve(located.gitDir, worktree)).catch(() => undefined);
    if (named !== located.root) return 'unsupported';
  }
  const emptyTree = format === 'sha256' ? EMPTY_TREE.sha256 : format === 'sha1' ? EMPTY_TREE.sha1 : failed('unknown object format');
  box.overrides = [...neutral].sort().flatMap(key => ['-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`]);
  return { ...box, remoteUrl, emptyTree, gitDir: located.gitDir };
}

// ---- Names, URLs, snapshots, cursors ----

/** A branch name as `git check-ref-format --branch` accepts one, never starting with '-' (no option, no revision syntax). */
export function validBranchName(name: unknown): name is string {
  if (typeof name !== 'string' || !name || name.length > WORKSPACE_GIT.maxRefLength) return false;
  if (name.startsWith('-') || name === 'HEAD' || name === '@') return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name) || name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  if (name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;
  return name.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.lock'));
}

/**
 * origin's URL as a client may see it: no user, password or token, no query or fragment; a local
 * path, a `file:` URL or anything unrecognized is null.
 */
export function scrubRemoteUrl(url: string | null): string | null {
  const value = url?.trim();
  if (!value || /[\x00-\x1f\x7f]/.test(value) || value.includes('::')) return null;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/.exec(value);
  if (scheme) {
    const protocol = scheme[1]!.toLowerCase();
    if (protocol === 'file') return null;
    const host = scheme[2]!.slice(scheme[2]!.lastIndexOf('@') + 1);
    return host ? `${protocol}://${host}${scheme[3]}` : null;
  }
  if (/^file:/i.test(value)) return null;
  // scp-like `[user@]host:path`: a colon before any slash, and not a Windows drive letter.
  const scp = /^(?:[^@/:]*@)?([^@/:]+):(.*)$/.exec(value);
  if (scp && scp[1]!.length > 1 && !scp[2]!.startsWith('\\')) return `${scp[1]}:${scp[2]}`;
  return null;
}

const hash = (...parts: Array<string | Buffer>) => {
  const digest = createHash('sha256');
  for (const part of parts) { digest.update(typeof part === 'string' ? part : part); digest.update('\0'); }
  return digest.digest('hex');
};

/** A file's identity and change marks for a snapshot, or a mark that it is not there. */
async function statMark(file: string): Promise<string> {
  try {
    const info = await lstat(file, { bigint: true });
    return `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch {
    return '-';
  }
}

type CursorBody = { offset: number; snapshot: string };

function cursorScope(workspaceId: string, compare: GitCompare, relative: string | undefined, body: CursorBody) {
  return JSON.stringify([workspaceId, compare.mode, compare.baseRef ?? null, compare.ignoreWhitespace === true, relative ?? null, body.snapshot, body.offset]);
}

// ---- Parsing Git's answers ----

/** An all-zero mode (no such side) or object id (the work tree, not hashed). */
const ZERO = /^0+$/;
const GITLINK = '160000';
const SYMLINK = '120000';

type Entry = {
  path: string; oldPath?: string; change: GitChange;
  srcMode: string; dstMode: string; srcOid: string; dstOid: string;
  untracked?: true; conflicted?: true;
};

const RAW_CHANGE: Record<string, GitChange> = { A: 'added', C: 'copied', D: 'deleted', M: 'modified', R: 'renamed', T: 'typechange', U: 'conflicted' };

/** `git diff --raw -z` records: `:<srcmode> <dstmode> <srcoid> <dstoid> <status>\0<path>\0[<path>\0]`. */
function parseRaw(output: Buffer): Entry[] {
  const fields = output.toString('utf8').split('\0');
  const entries: Entry[] = [];
  const conflicted = new Set<string>();
  for (let index = 0; index < fields.length;) {
    const meta = fields[index++];
    if (!meta) continue;
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([ACDMRTUX])(\d*)$/.exec(meta);
    if (!match) failed('unexpected change list');
    const [, srcMode, dstMode, srcOid, dstOid, letter] = match!;
    const first = fields[index++];
    const second = letter === 'R' || letter === 'C' ? fields[index++] : undefined;
    if (!first || (second !== undefined && !second)) failed('unexpected change list');
    if (letter === 'X') continue;
    const entry: Entry = second !== undefined
      ? { path: second, oldPath: first!, change: RAW_CHANGE[letter!]!, srcMode: srcMode!, dstMode: dstMode!, srcOid: srcOid!, dstOid: dstOid! }
      : { path: first!, change: RAW_CHANGE[letter!]!, srcMode: srcMode!, dstMode: dstMode!, srcOid: srcOid!, dstOid: dstOid! };
    if (letter === 'U') { conflicted.add(entry.path); entry.conflicted = true; }
    entries.push(entry);
  }
  // Index against work tree in a conflict: Git lists the path unmerged and again against stage 2
  // ("ours"); one entry, conflicted, compared as stage 2 against the work tree.
  const merged: Entry[] = [];
  for (const entry of entries) {
    if (!conflicted.has(entry.path)) { merged.push(entry); continue; }
    if (entry.conflicted) {
      const ours = entries.find(other => other.path === entry.path && !other.conflicted);
      merged.push(ours ? { ...ours, change: 'conflicted', conflicted: true } : entry);
    }
  }
  return merged;
}

/** Git's C-style quoting of a header path (quote.c, core.quotePath=false). */
function quoted(name: string): string {
  if (!/[\x00-\x1f"\\\x7f]/.test(name)) return name;
  let out = '"';
  for (const byte of Buffer.from(name, 'utf8')) {
    const letter = { 7: 'a', 8: 'b', 9: 't', 10: 'n', 11: 'v', 12: 'f', 13: 'r' }[byte];
    if (letter) out += `\\${letter}`;
    else if (byte === 0x22) out += '\\"';
    else if (byte === 0x5c) out += '\\\\';
    else if (byte < 0x20 || byte === 0x7f) out += `\\${byte.toString(8).padStart(3, '0')}`;
    else out += String.fromCharCode(byte);
  }
  // Bytes over 0x7f were added one by one: put the UTF-8 back together.
  return Buffer.from(`${out}"`, 'latin1').toString('utf8');
}
const headerOf = (entry: Entry) => `diff --git ${quoted(`a/${entry.oldPath ?? entry.path}`)} ${quoted(`b/${entry.path}`)}`;

type Section = { header: string; bytes: number; chunks: Buffer[] };

/**
 * A patch stream cut into its files' sections, each begun by a `diff --git ` line (no content
 * line can start so: they start with ' ', '+', '-' or '\'). A section keeps at most
 * `keepBytes` (then only its size is counted); the stream at most GIT_READ.maxPatchStreamBytes.
 */
function sectionsOf(keepBytes: number) {
  const sections: Section[] = [];
  let buffer: Buffer = Buffer.alloc(0);
  let atLineStart = true;
  let inHeader = false;
  let total = 0;
  const MARK = Buffer.from('diff --git ');
  // A conflicted path compared as stage 2 is announced so, outside any section.
  const UNMERGED = Buffer.from('* Unmerged path ');
  let skipping = false;
  const append = (bytes: Buffer) => {
    const current = sections.at(-1);
    if (!current) failed('patch output before a header');
    current!.bytes += bytes.length;
    if (current!.bytes <= keepBytes + 1) current!.chunks.push(Buffer.from(bytes));
  };
  function consume(ended: boolean) {
    let at = 0;
    for (;;) {
      if (inHeader) {
        const newline = buffer.indexOf(10, at);
        if (newline < 0) { if (buffer.length - at > 64 * 1024) failed('patch header over its bound'); break; }
        const line = buffer.subarray(at, newline);
        sections.push({ header: line.toString('utf8'), bytes: line.length + 1, chunks: [] });
        at = newline + 1;
        inHeader = false;
        atLineStart = true;
        continue;
      }
      if (at >= buffer.length) break;
      if (skipping) {
        const newline = buffer.indexOf(10, at);
        if (newline < 0) { if (buffer.length - at > 64 * 1024) failed('patch marker over its bound'); break; }
        at = newline + 1;
        skipping = false;
        atLineStart = true;
        continue;
      }
      if (atLineStart) {
        if (buffer.length - at < UNMERGED.length && !ended) break;
        if (buffer.subarray(at, at + MARK.length).equals(MARK)) { inHeader = true; continue; }
        if (buffer.subarray(at, at + UNMERGED.length).equals(UNMERGED)) { skipping = true; continue; }
        atLineStart = false;
      }
      const newline = buffer.indexOf(10, at);
      if (newline < 0) { append(buffer.subarray(at)); at = buffer.length; break; }
      append(buffer.subarray(at, newline + 1));
      at = newline + 1;
      atLineStart = true;
    }
    buffer = buffer.subarray(at);
    if (ended && (buffer.length || inHeader || skipping)) failed('unterminated patch');
  }
  return {
    sections,
    write(chunk: Buffer) {
      total += chunk.length;
      if (total > GIT_READ.maxPatchStreamBytes) failed('patch output over its bound');
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      consume(false);
    },
    end() { consume(true); },
  };
}

const DECODER = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });

/** One file's section as the contract's structure: binary per Git, or its hunks. */
function parseSection(section: Section): { binary: boolean; hunks: GitDiffHunk[]; additions: number; deletions: number } {
  const lines = DECODER.decode(Buffer.concat(section.chunks)).split('\n');
  const hunks: GitDiffHunk[] = [];
  let additions = 0;
  let deletions = 0;
  let hunk: GitDiffHunk | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of lines) {
    if (!hunk && (line === 'GIT binary patch' || (line.startsWith('Binary files ') && line.endsWith(' differ')))) return { binary: true, hunks: [], additions: 0, deletions: 0 };
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header && oldLeft <= 0 && newLeft <= 0) {
      const context = line.slice(header[0].length).replace(/^ /, '');
      hunk = { oldStart: Number(header[1]), oldCount: Number(header[2] ?? 1), newStart: Number(header[3]), newCount: Number(header[4] ?? 1), ...(context ? { context } : {}), lines: [] };
      oldLeft = hunk.oldCount;
      newLeft = hunk.newCount;
      hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line.startsWith('\\')) { const last = hunk.lines.at(-1); if (last) last.noNewline = true; continue; }
    if (oldLeft <= 0 && newLeft <= 0) continue;
    if (line.startsWith('+')) { hunk.lines.push({ type: 'add', content: line.slice(1) }); additions++; newLeft--; }
    else if (line.startsWith('-')) { hunk.lines.push({ type: 'remove', content: line.slice(1) }); deletions++; oldLeft--; }
    else if (line.startsWith(' ') || line === '') { hunk.lines.push({ type: 'context', content: line.slice(1) }); oldLeft--; newLeft--; }
  }
  return { binary: false, hunks, additions, deletions };
}

/** An untracked file's content as one hunk of added lines. */
function addedHunks(text: string): { hunks: GitDiffHunk[]; additions: number } {
  if (!text) return { hunks: [], additions: 0 };
  const endsWithNewline = text.endsWith('\n');
  const parts = (endsWithNewline ? text.slice(0, -1) : text).split('\n');
  const lines = parts.map(content => ({ type: 'add' as const, content }));
  if (!endsWithNewline) (lines.at(-1) as { noNewline?: true }).noNewline = true;
  return { hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: lines.length, lines }], additions: lines.length };
}

const holdsKey = (bytes: Buffer) => PRIVATE_KEY.test(bytes.toString('latin1'));

// ---- The service ----

export type GitReaderOptions = {
  registry: { resolve(workspaceId: string): Promise<string> };
  /** Which git: a name looked up on PATH (outside the workspace), or an absolute path (tests). */
  binary?: string;
  timeoutMs?: number;
  log?: (message: string, fields: Record<string, unknown>) => void;
};

type DiffParams = { workspaceId: string; compare: GitCompare; path?: string; cursor?: string };

export function createGitReader({ registry, binary = 'git', timeoutMs = GIT_READ.timeoutMs, log = () => {} }: GitReaderOptions) {
  const key = randomBytes(32);
  const mac = (scope: string) => createHmac('sha256', key).update(scope).digest('base64url').slice(0, 32);

  /** The workspace's real path, or the registry's refusal (its messages are fixed). */
  async function workspaceRoot(workspaceId: unknown): Promise<string> {
    if (typeof workspaceId !== 'string' || !workspaceId) throw new RpcError(RPC_ERROR.invalidParams, 'workspaceId is required', { reason: 'invalid_params' });
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
    const take = (row: GitStatusFile) => {
      dirty = true;
      if (blockedFilePath(row.path) || (row.oldPath && blockedFilePath(row.oldPath)) || [...row.path].length > 4096 || [...(row.oldPath ?? '')].length > 4096) { hiddenCount++; return false; }
      if (files.length >= WORKSPACE_GIT.maxStatusFiles) { truncated = true; return true; }
      files.push(row);
      return false;
    };
    const record = (field: string): boolean => {
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
      if (kind === '?') { const rowPath = field.slice(2).replace(/\/$/, ''); return rowPath ? take({ path: rowPath, change: 'untracked', staged: false, unstaged: true }) : false; }
      if (kind === '!') return false;
      failed('unexpected status');
      return false;
    };
    let seen = 0;
    const { stopped } = await runGit(repo, ['status', '--porcelain=v2', '-z', '--branch', '--ahead-behind', '--untracked-files=all', '--ignored=no', '--ignore-submodules=dirty', '--find-renames'], {
      onData: chunk => {
        seen += chunk.length;
        digest.update(chunk);
        const fields = (pending + chunk.toString('utf8')).split('\0');
        pending = fields.pop()!;
        for (const field of fields) if (field && record(field)) return true;
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
    return {
      state: 'repository', branch: current, detached, head, upstream, baseRef, aheadBehind, hasRemote: repo.remoteUrl !== null,
      remoteUrl: scrubRemoteUrl(repo.remoteUrl), dirty, files, hiddenCount, truncated, snapshot: `s1.${digest.digest('hex').slice(0, 40)}`,
    };
  }

  /** The untracked files Git does not ignore, at most `limit` that are not blocked (more: `more`). */
  async function untrackedOf(repo: Repository, relative: string | undefined, limit: number) {
    const found: string[] = [];
    let hidden = 0;
    let more = false;
    let pending = '';
    const { stopped } = await runGit(repo, ['ls-files', '-z', '--others', '--exclude-standard', '--', ...(relative ? [relative] : [])], {
      onData: chunk => {
        const fields = (pending + chunk.toString('utf8')).split('\0');
        pending = fields.pop()!;
        for (const name of fields) {
          // A nested repository is listed as its directory: not a file.
          if (!name || name.endsWith('/')) continue;
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
        const cost = 256 + result.cost;
        if (files.length && used + cost > WORKSPACE_GIT.maxTotalBytes) { next = start + index; break; }
        used += cost;
        files.push(result.file);
      }
      start += window.entries.length;
    }
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
    const shown = (entry: Entry, kind: GitDiffFile['kind'], extra: Partial<GitDiffFile> = {}, cost = 0): Result => ({
      file: { path: entry.path, ...(entry.oldPath ? { oldPath: entry.oldPath } : {}), change: entry.change, kind, additions: 0, deletions: 0, hunks: [], ...extra }, cost: cost + Buffer.byteLength(entry.path) + Buffer.byteLength(entry.oldPath ?? ''),
    });
    const readable = (size: number) => size <= GIT_READ.maxScanBytes;
    const wanted = new Map<string, number>();
    for (const entry of planned) {
      for (const [side, size] of [[entry.old, entry.sizes[0]], [entry.new, entry.sizes[1]]] as const) if (side && 'oid' in side && readable(size)) wanted.set(side.oid, size);
    }
    const contents = await blobs(repo, [...wanted.keys()], [...wanted.values()].reduce((sum, size) => sum + size, 0));
    const results: Result[] = new Array(planned.length).fill(undefined);
    const patched: Array<{ index: number; entry: Planned; group: 'plain' | 'renamed' | 'ours' }> = [];
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
          const parsed = parseSection(section);
          results[item!.index] = parsed.binary
            ? shown(item!.entry, 'binary')
            : shown(item!.entry, 'text', { additions: parsed.additions, deletions: parsed.deletions, hunks: parsed.hunks }, section.bytes);
        }
        // A file Git listed but gave no section for has no content change (its stat only changed).
      }
    }
    return results;
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
    return shown(entry, 'text', { additions, hunks }, bytes.length + additions);
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
  };
}

export type GitReader = ReturnType<typeof createGitReader>;
