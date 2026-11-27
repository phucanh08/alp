import { spawn } from 'node:child_process';
import { ERROR } from '@anhlp/alp-protocol';
import { RpcError } from '../rpc/rpc-error.ts';

export const GIT_READ = Object.freeze({
  /** One call (all of its Git processes, waiting for a turn included) gets this long. */
  timeoutMs: 15_000,
  /** Git processes these reads run at once in alpd, and processes that may wait for one. */
  maxConcurrent: 4,
  maxQueued: 32,
  maxErrorBytes: 16 * 1024,
  /** Configuration, change list and untracked list output, at most. */
  maxListBytes: 16 * 1024 * 1024,
  /** Ancestors retained per listing; exceeding the budget fails the read closed. */
  maxAncestors: 16_384,
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

export const FIXED = Object.freeze({
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
  noRegistry: 'Registry needs ALP_HOME',
  invalidDirectory: 'directory must be an absolute, normalised path with no . or .. segment',
  noDirectory: 'No directory at this path',
  notDirectory: 'The path is not a directory',
});

/** A Git read that failed: answered as `1000 git_failed` with a fixed message; `cause` is logged only. */
export class GitReadFailed extends Error {
  declare readonly cause: string;
  constructor(cause: string) { super(FIXED.failed); this.cause = cause; }
}

export const failed = (why: string): never => { throw new GitReadFailed(why); };
export const gitFailed = () => new RpcError(ERROR.failed, FIXED.failed, { reason: 'git_failed' });

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

export type Box = { git: string; root: string; env: NodeJS.ProcessEnv; deadline: number; overrides: string[] };

export const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

/** Flags before every subcommand: nothing the repository names may run, nothing is paged or coloured. */
const BOXED = [
  '--no-pager', '--literal-pathspecs',
  '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${NULL_DEVICE}`, '-c', 'core.pager=cat', '-c', 'core.untrackedCache=false',
  '-c', 'core.quotePath=false', '-c', 'color.ui=never', '-c', 'diff.autoRefreshIndex=false', '-c', 'diff.noprefix=false',
  '-c', 'diff.mnemonicPrefix=false', '-c', 'diff.relative=false', '-c', 'diff.suppressBlankEmpty=false', '-c', `diff.orderFile=${NULL_DEVICE}`,
  '-c', 'log.showSignature=false', '-c', 'submodule.recurse=false', '-c', 'protocol.allow=never', '-c', 'maintenance.auto=false',
  '-c', 'gc.auto=0', '-c', 'status.showStash=false', '-c', 'status.renames=true', '-c', 'diff.renames=true',
];

type RunOptions = {
  stdin?: string;
  okCodes?: number[];
  /** Collect at most this much stdout; more fails (GitReadFailed). */
  maxBytes?: number;
  /** Stream stdout instead: return true to stop Git (killed; the result says `stopped`). */
  onData?: (chunk: Buffer) => boolean | void | Promise<boolean | void>;
};

export function runGit(box: Box, args: string[], { stdin, okCodes = [0], maxBytes = GIT_READ.maxListBytes, onData }: RunOptions = {}): Promise<{ code: number; stdout: Buffer; stopped: boolean }> {
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
      child.stdout?.resume();
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let consuming: Promise<void> = Promise.resolve();
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // An issued lstat cannot be cancelled. Retain this read's slot until its
      // consumer settles, even when the caller's deadline has already returned,
      // so repeated timeouts cannot accumulate unlimited filesystem requests.
      void consuming.then(release);
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
    // Chunks are consumed strictly one after another: each consumer is chained after
    // the previous one, so close/finish/release wait for every pending check. pause()
    // is backpressure only; Node resumes stdout itself when the child exits
    // (flushStdio), so it cannot provide mutual exclusion.
    child.stdout!.on('data', (chunk: Buffer) => {
      if (settled || stopped) return;
      child.stdout!.pause();
      consuming = consuming.then(async () => {
        if (settled || stopped) return;
        if (onData) {
          if (await onData(chunk)) { stopped = true; kill(); }
        } else {
          outBytes += chunk.length;
          if (outBytes > maxBytes) throw new GitReadFailed('output over its bound');
          out.push(chunk);
        }
      }).then(() => {
        if (!settled && !stopped) child.stdout!.resume();
      }, error => finish(() => { kill(); reject(error); }));
    });
    child.stderr!.on('data', (chunk: Buffer) => { if (err.length < GIT_READ.maxErrorBytes) err += chunk.toString('utf8'); });
    child.on('error', error => finish(() => reject(new GitReadFailed(`spawn: ${error.message}`))));
    child.on('close', code => {
      void consuming.then(() => finish(() => {
        if (stopped) { resolve({ code: code ?? -1, stdout: Buffer.alloc(0), stopped: true }); return; }
        if (code === null || !okCodes.includes(code)) { reject(new GitReadFailed(`${args[0]} exit ${code}: ${err.trim().slice(0, 1000)}`)); return; }
        resolve({ code, stdout: Buffer.concat(out), stopped: false });
      }));
    });
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
export function recentEnough(box: Box): Promise<boolean> {
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

