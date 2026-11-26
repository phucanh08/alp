import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, lstat, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { ownerRegistry } from './host.ts';
import type { DashboardOwnerHandler } from './index.ts';

/**
 * host.workspace.facts (t-ff83; docs/alp/remote-gateway.md §5.19): what the owner's sidebar shows
 * under each workspace, read on this host for the host owner only. One `handler: true` entry in the
 * `// --- owner: host ---` block of apps/gateway/src/policy.ts; never forwarded to alpd.
 *
 * params  { workspaceIds: string[] (1..FACTS.maxIds), refresh?: boolean }
 * result  { workspaces: { [workspaceId]: WorkspaceFacts } }
 *
 * Nothing in params is a path: each id is looked up in alpd's registry (registry.owner, on the
 * owner's connection) and only that workspace's own directory is read. An id the registry does not
 * know (or whose project was removed) is left out. Every field is fail soft: no Git, no repository,
 * no remote, no gh, gh not logged in, no pull request, no icon: that field is absent, never an
 * error for the whole call.
 *
 *   branch     `git symbolic-ref --short HEAD` (absent when detached);
 *   additions / deletions   `git diff --numstat` of the work tree (committed and uncommitted
 *              changes of tracked files) against the merge-base of HEAD and the repository's base
 *              branch: origin/HEAD, else origin/main, origin/master, main, master; without one,
 *              uncommitted changes against HEAD. Untracked files are not counted; binary files
 *              count 0;
 *   pr, ci     `gh pr view <branch> --json number,state,isDraft,statusCheckRollup` in the
 *              workspace directory, only when the repository has a remote (see ciOf for ci);
 *   icon       the first file of ICON_CANDIDATES inside the workspace (after links, still inside
 *              its real path), a PNG, SVG or ICO by extension AND content, at most
 *              FACTS.iconMaxBytes, as a base64 data: URI (the app shows it only through <img>).
 *
 * Bounds: Git and gh run with execFile (argument lists, no shell), each with a timeout and a
 * maxBuffer, in a per-directory deadline; at most FACTS.concurrency directories are read at once;
 * one read per directory is in flight however many calls ask; an answer is reused for FACTS.ttlMs
 * (an empty or failed one only for FACTS.refreshMinMs),
 * and `refresh: true` reads again only when the last read is FACTS.refreshMinMs old.
 *
 * Git ignores global configuration, so a `safe.directory` entry there does not apply: a repository
 * owned by another user shows no Git facts (fail soft).
 *
 * Git runs as alpd's Git reads do (packages/daemon/src/git.ts), only less strictly: no system or
 * global configuration, no optional locks, no prompts, nothing the repository configures runs (no
 * fsmonitor, hooks, pager, external diff, textconv, filter drivers), no network protocol. gh gets
 * the same fsmonitor and hooks overrides for the Git it starts. Both executables are found on PATH
 * (absolute entries outside the workspace), so a test puts a fake gh first on PATH.
 */

export const FACTS = Object.freeze({
  maxIds: 50,
  ttlMs: 60_000,
  refreshMinMs: 10_000,
  concurrency: 4,
  /** One Git or gh process, at most. */
  timeoutMs: 8_000,
  /** All of one directory's processes, at most. */
  directoryMs: 20_000,
  maxBuffer: 1024 * 1024,
  iconMaxBytes: 256 * 1024,
});

/**
 * Logo files looked for in a workspace, in this order, relative to its root. Only these names;
 * the extension says the type and the content must agree.
 */
export const ICON_CANDIDATES = Object.freeze([
  'icon.svg', 'icon.png', 'logo.svg', 'logo.png', 'favicon.svg', 'favicon.png', 'favicon.ico',
  '.github/icon.svg', '.github/icon.png', '.github/logo.svg', '.github/logo.png',
  'assets/icon.svg', 'assets/icon.png', 'assets/logo.svg', 'assets/logo.png',
  'public/icon.svg', 'public/icon.png', 'public/logo.svg', 'public/logo.png', 'public/favicon.svg', 'public/favicon.png', 'public/favicon.ico',
  'static/favicon.svg', 'static/favicon.png', 'static/favicon.ico',
  'app/icon.svg', 'app/icon.png', 'app/favicon.ico', 'src/app/icon.svg', 'src/app/icon.png', 'src/app/favicon.ico',
  'docs/logo.svg', 'docs/logo.png',
]);

const MIME = Object.freeze({ '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' });

export type WorkspaceFacts = {
  branch?: string;
  additions?: number;
  deletions?: number;
  pr?: { number: number; state: 'open' | 'draft' | 'merged' | 'closed' };
  ci?: 'passed' | 'failed' | 'pending';
  icon?: string;
  fetchedAt: string;
};
export type WorkspaceFactsParams = { workspaceIds: string[]; refresh?: boolean };
export type WorkspaceFactsResult = { workspaces: Record<string, WorkspaceFacts> };

const invalid = (message: string) => Object.assign(new Error(message), { code: -32602, data: { reason: 'invalid_params' } });

export function factsParams(params: Record<string, any>): WorkspaceFactsParams { // any: the request's params, checked here
  const ids = params.workspaceIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > FACTS.maxIds) throw invalid(`workspaceIds must be a list of 1 to ${FACTS.maxIds} workspace ids`);
  for (const id of ids) if (typeof id !== 'string' || !id || id.length > 200 || id.includes('\0')) throw invalid('workspaceIds must hold non-empty strings of at most 200 characters');
  if (params.refresh !== undefined && typeof params.refresh !== 'boolean') throw invalid('refresh must be true or false');
  return { workspaceIds: [...new Set(ids)], ...(params.refresh ? { refresh: true } : {}) };
}

/**
 * ci from a statusCheckRollup: any failure, error, cancellation or timeout → failed; else anything
 * not finished (or a state this does not know) → pending; else (success, neutral, skipped) passed;
 * no checks → undefined.
 */
export function ciOf(rollup: unknown): WorkspaceFacts['ci'] {
  if (!Array.isArray(rollup) || !rollup.length) return undefined;
  const FAILED = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'];
  const PASSED = ['SUCCESS', 'NEUTRAL', 'SKIPPED'];
  let pending = false;
  for (const check of rollup) {
    // A CheckRun has status and conclusion; a StatusContext has state.
    const status = typeof check?.status === 'string' ? check.status.toUpperCase() : undefined;
    const outcome = String(check?.conclusion || check?.state || '').toUpperCase();
    if (FAILED.includes(outcome)) return 'failed';
    if ((status && status !== 'COMPLETED') || !PASSED.includes(outcome)) pending = true;
  }
  return pending ? 'pending' : 'passed';
}

/** pr from gh's answer, or undefined. */
export function prOf(view: any): WorkspaceFacts['pr'] { // any: gh's JSON answer, checked field by field
  if (!view || !Number.isSafeInteger(view.number) || view.number <= 0) return undefined;
  const state = String(view.state ?? '').toUpperCase();
  if (state === 'MERGED') return { number: view.number, state: 'merged' };
  if (state === 'CLOSED') return { number: view.number, state: 'closed' };
  if (state === 'OPEN') return { number: view.number, state: view.isDraft === true ? 'draft' : 'open' };
  return undefined;
}

/** Sums `git diff --numstat` output (binary files, `-`, count 0). */
export function numstat(output: string): { additions: number; deletions: number } {
  let additions = 0, deletions = 0;
  for (const line of output.split('\n')) {
    const [added, deleted] = line.split('\t');
    if (/^\d+$/.test(added ?? '')) additions += Number(added);
    if (/^\d+$/.test(deleted ?? '')) deletions += Number(deleted);
  }
  return { additions, deletions };
}

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';
const GIT_OVERRIDES = [
  'core.fsmonitor=false', `core.hooksPath=${NULL_DEVICE}`, 'core.pager=cat', 'core.untrackedCache=false', 'color.ui=never',
  'diff.autoRefreshIndex=false', 'submodule.recurse=false', 'protocol.allow=never', 'maintenance.auto=false', 'gc.auto=0',
];

/** Whether `target` is `root` or lies under it (both real paths). */
export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * An executable `name` on env.PATH: absolute entries only, none inside `root`.
 */
export async function onPath(name: string, env: NodeJS.ProcessEnv, root: string): Promise<string | undefined> {
  const names = process.platform === 'win32' ? [`${name}.exe`] : [name];
  for (const entry of String(env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!entry || !path.isAbsolute(entry)) continue;
    // The entry as it really is: a link that leads into the workspace counts as inside it.
    const real = await realpath(entry).catch(() => undefined);
    if (!real || isInside(root, real)) continue;
    for (const file of names) {
      const candidate = path.join(entry, file);
      const ok = await stat(candidate).then(info => info.isFile(), () => false) && await access(candidate, fsConstants.X_OK).then(() => true, () => false);
      if (ok) return candidate;
    }
  }
  return undefined;
}

/**
 * Runs a file with an argument list (no shell); answers stdout, or undefined when it fails, times
 * out, or prints more than FACTS.maxBuffer.
 */
function run(file: string, args: string[], { cwd, env, deadline }: { cwd: string; env: NodeJS.ProcessEnv; deadline: number }): Promise<string | undefined> {
  const timeout = Math.min(FACTS.timeoutMs, deadline - Date.now());
  if (timeout <= 0) return Promise.resolve(undefined);
  return new Promise(resolve => {
    execFile(file, args, { cwd, env, timeout, killSignal: 'SIGKILL', maxBuffer: FACTS.maxBuffer, encoding: 'utf8', windowsHide: true, shell: false },
      (error, stdout) => resolve(error ? undefined : stdout));
  });
}

/** env without Git's own variables (they would redirect Git elsewhere). */
function withoutGit(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')));
}

/** Configuration overrides as GIT_CONFIG_COUNT variables, for the Git gh starts. */
function configEnv(pairs: string[]): Record<string, string> {
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach((pair, index) => {
    const at = pair.indexOf('=');
    env[`GIT_CONFIG_KEY_${index}`] = pair.slice(0, at);
    env[`GIT_CONFIG_VALUE_${index}`] = pair.slice(at + 1);
  });
  return env;
}

/**
 * The workspace's logo as a data: URI, or undefined.
 * @param directory the workspace directory
 */
export async function iconOf(directory: string): Promise<string | undefined> {
  const root = await realpath(directory).catch(() => undefined);
  if (!root) return undefined;
  for (const relative of ICON_CANDIDATES) {
    const icon = await readIcon(root, relative).catch(() => undefined);
    if (icon) return icon;
  }
  return undefined;
}

async function readIcon(root: string, relative: string): Promise<string | undefined> {
  const candidate = path.join(root, relative);
  if (!await lstat(candidate).then(() => true, () => false)) return undefined;
  const real = await realpath(candidate);
  if (real === root || !isInside(root, real)) return undefined;
  // The extension of both names must be the allowed one: a link named logo.png to secret.txt is not an icon.
  const extension = path.extname(relative).toLowerCase();
  if (path.extname(real).toLowerCase() !== extension) return undefined;
  const mime = MIME[extension as keyof typeof MIME];
  if (!mime) return undefined;
  const handle = await open(real, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size <= 0 || info.size > FACTS.iconMaxBytes) return undefined;
    const buffer = Buffer.alloc(FACTS.iconMaxBytes + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
      if (length > FACTS.iconMaxBytes) return undefined;
    }
    const bytes = buffer.subarray(0, length);
    if (!length || !looksLike(extension, bytes)) return undefined;
    return `data:${mime};base64,${bytes.toString('base64')}`;
  } finally { await handle.close(); }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ICO = Buffer.from([0x00, 0x00, 0x01, 0x00]);

/** Whether the content is the type its extension names. */
export function looksLike(extension: string, bytes: Buffer): boolean {
  if (extension === '.png') return bytes.length > PNG.length && bytes.subarray(0, PNG.length).equals(PNG);
  if (extension === '.ico') return bytes.length > 6 && bytes.subarray(0, ICO.length).equals(ICO);
  if (extension === '.svg') {
    const head = bytes.subarray(0, 4096).toString('utf8').replace(/^﻿/, '').trimStart();
    return head.startsWith('<') && /<svg[\s>]/i.test(head);
  }
  return false;
}

/**
 * Reads one directory's facts. Never throws.
 */
export async function readFacts(directory: string, { env }: { env: NodeJS.ProcessEnv }): Promise<Omit<WorkspaceFacts, 'fetchedAt'>> {
  const deadline = Date.now() + FACTS.directoryMs;
  const root = await realpath(directory).catch(() => undefined);
  if (!root || !await stat(root).then(info => info.isDirectory(), () => false)) return {};
  const facts: Omit<WorkspaceFacts, 'fetchedAt'> = {};
  const icon = await iconOf(root);

  const git = await onPath('git', env, root);
  if (git) {
    const gitEnv = { ...withoutGit(env), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: NULL_DEVICE, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', LC_ALL: 'C' };
    const options = { cwd: root, env: gitEnv, deadline };
    const base = GIT_OVERRIDES.flatMap(pair => ['-c', pair]);
    // Filter drivers the repository's configuration names would run on a work tree diff: emptied.
    const filters = new Set<string>();
    for (const key of (await run(git, [...base, 'config', '--name-only', '--get-regexp', '^filter\\.'], options) ?? '').split('\n')) {
      const name = key.trim();
      if (name.startsWith('filter.') && name.lastIndexOf('.') > 'filter.'.length) filters.add(name.slice('filter.'.length, name.lastIndexOf('.')));
    }
    const boxed = [...base, ...[...filters].flatMap(driver => ['-c', `filter.${driver}.clean=`, '-c', `filter.${driver}.smudge=`, '-c', `filter.${driver}.process=`, '-c', `filter.${driver}.required=false`])];
    const gitRun = (args: string[]): Promise<string | undefined> => run(git, [...boxed, ...args], options);

    const head = (await gitRun(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']))?.trim();
    if (head) {
      const branch = (await gitRun(['symbolic-ref', '--quiet', '--short', 'HEAD']))?.trim();
      if (branch && !branch.startsWith('-')) facts.branch = branch;

      let baseRef = (await gitRun(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']))?.trim() || undefined;
      if (baseRef && !baseRef.startsWith('refs/remotes/origin/')) baseRef = undefined;
      for (const ref of ['refs/remotes/origin/main', 'refs/remotes/origin/master', 'refs/heads/main', 'refs/heads/master']) {
        if (baseRef) break;
        if ((await gitRun(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]))?.trim()) baseRef = ref;
      }
      const mergeBase = baseRef ? (await gitRun(['merge-base', '--end-of-options', 'HEAD', baseRef]))?.trim() : undefined;
      const against = mergeBase && /^[0-9a-f]{40,64}$/.test(mergeBase) ? mergeBase : 'HEAD';
      const diff = await gitRun(['diff', '--numstat', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', against, '--']);
      if (diff !== undefined) Object.assign(facts, numstat(diff));

      const remotes = (await gitRun(['remote']))?.trim();
      const gh = facts.branch && remotes ? await onPath('gh', env, root) : undefined;
      // `gh pr view <n>` reads an all-digit argument as a pull request number, not a branch.
      if (gh && facts.branch && !/^\d+$/.test(facts.branch)) {
        const ghEnv = { ...withoutGit(env), ...configEnv([`core.fsmonitor=false`, `core.hooksPath=${NULL_DEVICE}`, 'protocol.ext.allow=never']), GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1', NO_COLOR: '1', CLICOLOR: '0' };
        const output = await run(gh, ['pr', 'view', facts.branch, '--json', 'number,state,isDraft,statusCheckRollup'], { cwd: root, env: ghEnv, deadline });
        let view: any; // any: gh's JSON answer, checked by prOf and ciOf
        try { view = output === undefined ? undefined : JSON.parse(output); } catch { view = undefined; }
        const pr = prOf(view);
        if (pr) {
          facts.pr = pr;
          const ci = ciOf(view.statusCheckRollup);
          if (ci) facts.ci = ci;
        }
      }
    }
  }
  if (icon) facts.icon = icon;
  return facts;
}

/**
 * A host.workspace.facts handler with its own cache, in-flight reads and concurrency limit.
 */
export function createWorkspaceFacts({ env = process.env, now = Date.now, read = readFacts }: { env?: NodeJS.ProcessEnv; now?: () => number; read?: typeof readFacts } = {}) {
  const cache = new Map<string, { facts: WorkspaceFacts; at: number; ttl: number }>();
  const inflight = new Map<string, Promise<WorkspaceFacts>>();
  let running = 0;
  const waiting: Array<() => void> = [];
  const acquire = () => running < FACTS.concurrency ? (running++, Promise.resolve()) : new Promise(resolve => waiting.push(() => { running++; resolve(undefined); }));
  const release = () => { running--; waiting.shift()?.(); };

  function factsOf(directory: string, refresh: boolean): Promise<WorkspaceFacts> {
    const pending = inflight.get(directory);
    if (pending) return pending;
    const cached = cache.get(directory);
    const age = cached ? now() - cached.at : Infinity;
    if (cached && (age < FACTS.refreshMinMs || (!refresh && age < cached.ttl))) return Promise.resolve(cached.facts);
    const reading = (async () => {
      await acquire();
      try {
        const read$ = await read(directory, { env }).catch(() => undefined);
        const facts = { ...read$, fetchedAt: new Date(now()).toISOString() };
        // A read that failed or found nothing (a timeout, a passing error) is kept only briefly, so
        // the sidebar's next poll after FACTS.refreshMinMs tries again instead of waiting the TTL.
        const ttl = read$ && Object.keys(read$).length ? FACTS.ttlMs : FACTS.refreshMinMs;
        cache.set(directory, { facts, at: now(), ttl });
        return facts;
      } finally { release(); inflight.delete(directory); }
    })();
    inflight.set(directory, reading);
    return reading;
  }

  const handler: DashboardOwnerHandler = async ({ params, daemon }) => {
    const { workspaceIds, refresh } = factsParams(params);
    // any: alpd's registry.owner answer, read through ownerRegistry
    const answer: any = (await daemon.request('registry.owner', {}));
    const registry = ownerRegistry(answer?.registry);
    // any: registry entries as alpd gave them; a directory is checked below before it is used
    const directories = new Map<string, any>(registry.workspaces.map((workspace: any) => [workspace.id, workspace.directory]));
    // Entries whose directory is not a plain absolute path are left out, as unknown ids are.
    const wanted = workspaceIds.filter(id => typeof directories.get(id) === 'string' && path.isAbsolute(directories.get(id)));
    const workspaces: Record<string, WorkspaceFacts> = {};
    await Promise.all(wanted.map(async id => { workspaces[id] = await factsOf(directories.get(id), refresh === true); }));
    return { workspaces: Object.fromEntries(wanted.filter(id => workspaces[id]).map(id => [id, workspaces[id]])) };
  };
  return { handler, cache, inflight, running: () => running };
}

export const methods: Readonly<Record<string, DashboardOwnerHandler>> = {
  'host.workspace.facts': createWorkspaceFacts().handler,
};
