import { spawn } from 'node:child_process';
import { accessSync, constants, lstatSync, realpathSync, statSync, type BigIntStats } from 'node:fs';
import path from 'node:path';

/**
 * Which paths of a workspace `.gitignore` hides, for workspace.files.list and workspace.files.read
 * (docs/protocol/alp-json-rpc-v1.md §12.4), as Git itself says: `git check-ignore`, so its rules
 * are Git's exactly (every `.gitignore` on the way, `.git/info/exclude`, `core.excludesFile`).
 *
 * The workspace is not trusted, so Git runs boxed in:
 * - the Git found on the absolute entries of PATH, by its real path: never a `git` the workspace
 *   holds (a relative or empty PATH entry, or Windows searching the working directory first, would
 *   run one), whatever the spelling of the entry or a link on the way (see resolveGit);
 * - spawned with an argument list, never a shell, in the workspace's real path;
 * - `--no-index`: the index is not read (no fsmonitor or index extension runs; a tracked file a
 *   rule matches is hidden too), and `core.fsmonitor` is turned off besides;
 * - an environment without any GIT_* variable of alpd's own, no prompts, no optional locks;
 * - paths on stdin separated by NUL (`-z`), each as `./<path>` so that Git reads none as pathspec
 *   magic (`:(glob)…`, `:!…`) and none is ever an argument;
 * - at most MAX_CONCURRENT at once in alpd, a bounded queue, a hard timeout that kills its whole
 *   process group, and a cap on what it may print.
 * A timeout, a crash, a refusal, a full queue or an answer that is not plainly a list of the paths
 * asked fails closed: the caller treats the paths as ignored. Git missing, or a workspace in no
 * repository (no `.git` in it or above it): no rules apply, and only the block list hides anything.
 */

export const GIT_CHECK = Object.freeze({
  /** Git gets this long per request, waiting for a turn included, then is killed. */
  timeoutMs: 2_000,
  /** Git processes alpd runs at once, and requests that may wait for one. */
  maxConcurrent: 4,
  maxQueued: 64,
  maxErrorBytes: 64 * 1024,
});

/** Git's answer could not be had: whether the paths are ignored is not known, so they count as ignored. */
export class IgnoreUnknown extends Error {
  constructor(why: string) { super(`git check-ignore failed: ${why}`); }
}

export type GitCheckOptions = { binary?: string; timeoutMs?: number };

/** alpd's environment without Git's variables (GIT_DIR, GIT_WORK_TREE, GIT_CONFIG_*…), which would point Git elsewhere. */
function gitEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!/^GIT_/i.test(key)) env[key] = value;
  return { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };
}

const executable = (file: string) => {
  try {
    if (!statSync(file).isFile()) return false;
    if (process.platform !== 'win32') accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The file system's identity of a directory: one per directory, whatever path names it. */
type Identity = Pick<BigIntStats, 'dev' | 'ino'>;
const identity = (file: string): Identity => { const { dev, ino } = statSync(file, { bigint: true }); return { dev, ino }; };
// macOS and Windows file systems compare names without case, mostly: a name compare there folds it.
const foldCase = process.platform === 'darwin' || process.platform === 'win32';
const comparable = (file: string) => (foldCase ? file.toLowerCase() : file);

/**
 * Whether `file` is `root` or inside it, however either is spelled: a case-insensitive file
 * system's other case, a Windows drive letter's case or 8.3 short name, a link, a bind mount. Both
 * are made real paths by the system (realpath(3), which spells names as they are stored), and then
 * each directory from `file` up to the file system's root is compared with `root` by device and
 * inode, and by its name (case-folded where names are, for a file system without inode numbers).
 * Anything that cannot be resolved or examined counts as inside: the caller skips it.
 */
function insideRoot(file: string, root: { path: string; id: Identity }): boolean {
  let directory;
  try { directory = realpathSync.native(file); } catch { return true; }
  const rootName = comparable(root.path.endsWith(path.sep) && root.path.length > 1 ? root.path.slice(0, -1) : root.path);
  for (;;) {
    const name = comparable(directory);
    if (name === rootName || name.startsWith(rootName.endsWith(path.sep) ? rootName : `${rootName}${path.sep}`)) return true;
    let id;
    try { id = identity(directory); } catch { return true; }
    if (root.id.ino !== 0n && id.dev === root.id.dev && id.ino === root.id.ino) return true;
    const parent = path.dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

/** The workspace as insideRoot compares it, or undefined if it cannot be examined. */
function rootOf(root: string): { path: string; id: Identity } | undefined {
  try {
    const real = realpathSync.native(root);
    return { path: real, id: identity(real) };
  } catch {
    return undefined;
  }
}

/**
 * The absolute path of `name` on the absolute entries of PATH (Windows: with .exe or .com), or
 * undefined. An absolute `name` (tests) is taken when it is an executable file. Relative and empty
 * PATH entries are skipped: they name the working directory, which is the workspace.
 *
 * With `root`, nothing in the workspace is ever the answer (alpd started by npm or npx has
 * `<project>/node_modules/.bin` on PATH): a PATH entry inside `root` is skipped, and so is a
 * binary that is, or links to, a file inside it; both by insideRoot, which no other spelling of
 * the path fools. The answer is then the binary's real path, so a link swapped later changes
 * nothing. A workspace that cannot be examined finds no Git at all (IgnoreUnknown).
 */
export function resolveGit(name = 'git', searchPath = process.env.PATH ?? process.env.Path ?? '', root?: string): string | undefined {
  const box = root === undefined ? undefined : rootOf(root);
  if (root !== undefined && !box) throw new IgnoreUnknown('the workspace cannot be examined');
  /** `file` as the answer, or undefined: not executable, or in the workspace. */
  const accept = (file: string) => {
    if (!executable(file)) return undefined;
    if (!box) return file;
    let real;
    try { real = realpathSync.native(file); } catch { return undefined; }
    return insideRoot(path.dirname(real), box) || !executable(real) ? undefined : real;
  };
  if (path.isAbsolute(name)) return accept(name);
  if (name.includes('/') || name.includes('\\')) return undefined;
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.com`] : [name];
  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory || !path.isAbsolute(directory)) continue;
    if (box && insideRoot(directory, box)) continue;
    for (const candidate of names) {
      const file = accept(path.join(directory, candidate));
      if (file) return file;
    }
  }
  return undefined;
}

/**
 * The absolute entries of PATH outside `root` (insideRoot), for the environment of a Git alpd runs
 * in a workspace: whatever Git itself starts is then never found in the workspace either.
 */
export function searchPathOutside(root: string, searchPath = process.env.PATH ?? process.env.Path ?? ''): string {
  const box = rootOf(root);
  if (!box) throw new IgnoreUnknown('the workspace cannot be examined');
  return searchPath.split(path.delimiter).filter(directory => directory && path.isAbsolute(directory) && !insideRoot(directory, box)).join(path.delimiter);
}

/** Whether `root` or a directory above it holds a `.git` entry: Git saying "not a git repository" there is a broken repository, not none. */
function hasGitEntry(root: string): boolean {
  for (let directory = root; ; directory = path.dirname(directory)) {
    try {
      lstatSync(path.join(directory, '.git'));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new IgnoreUnknown('cannot examine .git');
    }
    if (path.dirname(directory) === directory) return false;
  }
}

// The slots: at most maxConcurrent Git processes; others wait in a bounded queue.
let running = 0;
const waiting: Array<() => void> = [];
function acquire(deadline: number): Promise<() => void> {
  const release = () => { running--; waiting.shift()?.(); };
  if (running < GIT_CHECK.maxConcurrent) { running++; return Promise.resolve(release); }
  if (waiting.length >= GIT_CHECK.maxQueued) return Promise.reject(new IgnoreUnknown('too many waiting'));
  return new Promise((resolve, reject) => {
    const turn = () => { clearTimeout(timer); running++; resolve(release); };
    const timer = setTimeout(() => {
      const index = waiting.indexOf(turn);
      if (index >= 0) waiting.splice(index, 1);
      reject(new IgnoreUnknown('timed out waiting for a turn'));
    }, Math.max(0, deadline - Date.now()));
    waiting.push(turn);
  });
}

/** Git processes running now, for tests. */
export const gitChecksRunning = () => running;

/**
 * The paths among `paths` (relative to `root`, '/'-separated, already checked) that Git ignores;
 * null when no rules apply (Git is not installed, or `root` is in no repository). Throws
 * IgnoreUnknown on anything else.
 */
export async function gitIgnored(root: string, paths: readonly string[], { binary = 'git', timeoutMs = GIT_CHECK.timeoutMs }: GitCheckOptions = {}): Promise<Set<string> | null> {
  if (!paths.length) return new Set();
  const git = resolveGit(binary, undefined, root);
  if (!git) return null;
  const deadline = Date.now() + timeoutMs;
  const release = await acquire(deadline);
  try {
    return await check(git, root, paths, deadline, timeoutMs);
  } finally {
    release();
  }
}

function check(git: string, root: string, paths: readonly string[], deadline: number, timeoutMs: number): Promise<Set<string> | null> {
  const input = `${paths.map(entry => `./${entry}`).join('\0')}\0`;
  // Git echoes only what it was asked, so what it prints never exceeds what it was sent.
  const maxOutputBytes = Buffer.byteLength(input) + 1024;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn>;
    // POSIX: its own process group, so a timeout kills whatever it started too.
    const group = process.platform !== 'win32';
    const kill = () => {
      try {
        if (group && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // already gone
      }
    };
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      outcome();
    };
    try {
      child = spawn(git, ['-c', 'core.fsmonitor=false', 'check-ignore', '--no-index', '--stdin', '-z'], {
        cwd: root, env: gitEnvironment(), shell: false, windowsHide: true, detached: group, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(new IgnoreUnknown(String((error as Error).message)));
      return;
    }
    timer = setTimeout(() => finish(() => { kill(); reject(new IgnoreUnknown('timed out')); }), Math.max(1, Math.min(timeoutMs, deadline - Date.now())));
    const out: Buffer[] = [];
    let outBytes = 0;
    let err = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > maxOutputBytes) finish(() => { kill(); reject(new IgnoreUnknown('more output than input')); });
      else out.push(chunk);
    });
    child.stderr!.on('data', (chunk: Buffer) => { if (err.length < GIT_CHECK.maxErrorBytes) err += chunk.toString('utf8'); });
    child.on('error', error => finish(() => {
      // Git was resolved already. ENOENT can also mean a missing cwd or interpreter;
      // it does not establish that no ignore rules apply.
      reject(new IgnoreUnknown(error.message));
    }));
    child.on('close', code => finish(() => {
      // No repository: no rules. A `.git` that Git cannot use (a worktree whose repository moved)
      // is not "no repository": fail closed.
      if (code === 128 && /not a git repository/i.test(err)) {
        try {
          if (hasGitEntry(root)) reject(new IgnoreUnknown('a .git Git cannot use'));
          else resolve(null);
        } catch (error) { reject(error); }
        return;
      }
      // 0: some paths are ignored; 1: none is.
      if (code !== 0 && code !== 1) { reject(new IgnoreUnknown(`exit ${code}`)); return; }
      if (err.length || (code === 1 && outBytes) || (code === 0 && !outBytes)) {
        reject(new IgnoreUnknown('inconsistent exit status or diagnostics')); return;
      }
      const output = Buffer.concat(out).toString('utf8');
      if (outBytes && !output.endsWith('\0')) { reject(new IgnoreUnknown('unterminated answer')); return; }
      const asked = new Set(paths);
      const ignored = new Set<string>();
      for (const entry of output.split('\0')) {
        if (!entry) continue;
        const relative = entry.startsWith('./') ? entry.slice(2) : undefined;
        if (relative === undefined || !asked.has(relative)) { reject(new IgnoreUnknown('an answer for a path not asked')); return; }
        ignored.add(relative);
      }
      resolve(ignored);
    }));
    // A Git that exits before reading everything closes the pipe: its exit decides.
    child.stdin!.on('error', () => {});
    child.stdin!.end(input);
  });
}
