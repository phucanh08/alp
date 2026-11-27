import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { user_worktree } from '@anhlp/alp-core';
import { ERROR, WORKSPACE_GIT } from '@anhlp/alp-protocol';
import { searchPathOutside } from './gitignore.ts';
import { RpcError } from '../rpc/rpc-error.ts';
import { type Box, FIXED, NULL_DEVICE, failed, recentEnough, runGit } from './git-process.ts';

// ---- The workspace and its repository ----

/** `top`, when unsupported: the nearest directory above the root that holds a `.git` entry. */
export type Located = { kind: 'not_repository' } | { kind: 'unsupported'; top: string } | { kind: 'repository'; root: string; gitDir: string };

export const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException)?.code ?? '');

/** Whether `root` is a repository's top level, inside one (a `.git` above it), or in none. */
export async function locate(root: string): Promise<Located> {
  let entry = true;
  try { await lstat(path.join(root, '.git')); } catch (error) { if (!missing(error)) failed('cannot examine .git'); entry = false; }
  if (!entry) {
    for (let directory = path.dirname(root); ; directory = path.dirname(directory)) {
      try { await lstat(path.join(directory, '.git')); return { kind: 'unsupported', top: directory }; } catch (error) { if (!missing(error)) failed('cannot examine .git above the workspace'); }
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
    ...env, PATH: searchPath!, GIT_DIR: gitDir, GIT_WORK_TREE: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: NULL_DEVICE, GIT_ATTR_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_PROTOCOL_FROM_USER: '0', LC_ALL: 'C', LANG: 'C',
  };
}

const EMPTY_TREE = { sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321' };

export type Repository = Box & { remoteUrl: string | null; emptyTree: string; gitDir: string; config: string };

/** The configuration a box is built from: origin, the work tree, the object format and every filter driver. */
const CONFIG_READ = ['config', '--null', '--get-regexp', '^(remote\\.origin\\.url|core\\.worktree|extensions\\.objectformat|filter\\..+\\.(smudge|clean|process|required))$'];

/**
 * Every Git process of a call reads the repository's configuration again. A filter driver (or
 * work tree) added while the call ran was not neutralized: the answer is refused (fails closed).
 */
export async function sameConfig(repo: Repository): Promise<void> {
  // Read as the box's first read was: without the overrides (`-c` entries are listed as configuration).
  const { stdout } = await runGit({ ...repo, overrides: [] }, CONFIG_READ, { okCodes: [0, 1] });
  if (hash(stdout) !== repo.config) failed('the repository configuration changed during the read');
}

/**
 * The box for a located repository: the configuration overrides that neutralize every filter it
 * names, origin's URL, its object format. A filter name `-c` cannot carry, or a work tree
 * configured elsewhere than the workspace, refuses (unsupported or failed), never runs Git
 * without the overrides.
 */
export async function boxFor(located: Extract<Located, { kind: 'repository' }>, git: string, deadline: number): Promise<Repository | 'unsupported'> {
  const box: Box = { git, root: located.root, env: environment(located.root, located.gitDir), deadline, overrides: [] };
  if (!(await recentEnough(box))) throw new RpcError(ERROR.unavailable, FIXED.tooOld, { reason: 'git_unavailable' });
  const { stdout } = await runGit(box, CONFIG_READ, { okCodes: [0, 1] });
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
  return { ...box, remoteUrl, emptyTree, gitDir: located.gitDir, config: hash(stdout) };
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
    // A slash inside malformed user information must not turn a credential
    // fragment into an apparent authority (for example user:pa/ss@host).
    try { if (!new URL(value).host) return null; } catch { return null; }
    const host = scheme[2]!.slice(scheme[2]!.lastIndexOf('@') + 1);
    return host ? `${protocol}://${host}${scheme[3]}` : null;
  }
  if (/^file:/i.test(value)) return null;
  // scp-like `[user[:password]@]host:path`: a colon before any slash, and not a Windows drive
  // letter. User information is everything up to the last '@' before the first slash.
  const slash = value.indexOf('/');
  const at = (slash < 0 ? value : value.slice(0, slash)).lastIndexOf('@');
  // A colon before the final @ is ambiguous with a repository path or malformed credentials.
  // Refuse rather than exposing part of user information as a host/path.
  if (value.includes('@') && value.indexOf(':') >= 0 && value.indexOf(':') < value.lastIndexOf('@')) return null;
  const scp = /^([^@/:]+):(.*)$/.exec(at < 0 ? value : value.slice(at + 1));
  if (scp && scp[1]!.length > 1 && !scp[2]!.startsWith('\\')) return `${scp[1]}:${scp[2]}`;
  return null;
}

export const hash = (...parts: Array<string | Buffer>) => {
  const digest = createHash('sha256');
  for (const part of parts) { digest.update(typeof part === 'string' ? part : part); digest.update('\0'); }
  return digest.digest('hex');
};

/** A file's identity and change marks for a snapshot, or a mark that it is not there. */
export async function statMark(file: string): Promise<string> {
  try {
    const info = await lstat(file, { bigint: true });
    return `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch {
    return '-';
  }
}

