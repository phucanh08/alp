/**
 * Running a program and collecting its output with a hard deadline. Node's execFile calls back only
 * when the child's stdio closes, so a child that ignores SIGTERM (an interactive shell), or a
 * grandchild that keeps the stdout pipe open (a background job an rc file starts), could leave the
 * caller waiting forever. run() settles on its own: when the child exits (after a short grace for
 * the last output), or at the deadline, where it kills the child with SIGKILL and drops its stdio.
 */
import { spawn } from 'node:child_process';

export type RunResult = {
  /** The exit code, or null when the child was killed, failed to start, or exited by a signal. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** True when the deadline was reached before the child exited. */
  timedOut: boolean;
  /** Why the child could not start (ENOENT, EACCES…). */
  error?: Error;
};

export type RunOptions = {
  env: NodeJS.ProcessEnv;
  timeout: number;
  /** How long to wait for stdio to close after the child exits; a grandchild may hold it open. */
  exitGrace?: number;
  /**
   * Start the child in its own process group and kill that group when run() answers: with SIGKILL
   * at the deadline, with SIGTERM after a normal exit (a background job an rc file left in the group).
   * A job that made its own group (a shell with job control) is not reached; the shell hangs it up.
   */
  killGroup?: boolean;
  /** The most bytes kept of each of stdout and stderr; the rest is dropped. */
  maxBuffer?: number;
  /** Written to the child's stdin, which is then closed; without it stdin is /dev/null. */
  input?: string;
};

export function run(file: string, args: string[], options: RunOptions): Promise<RunResult> {
  const { env, timeout, exitGrace = 500, killGroup = false, maxBuffer = 1 << 20, input } = options;
  return new Promise<RunResult>(resolve => {
    const out = collector(maxBuffer);
    const err = collector(maxBuffer);
    let code: number | null = null;
    let exited = false;
    let settled = false;
    let timedOut = false;
    let startError: Error | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const child = spawn(file, args, { env, shell: false, windowsHide: true, detached: killGroup, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (input !== undefined && child.stdin) {
      // A child that exits before reading all of it closes the pipe (EPIPE): its exit code says why.
      child.stdin.on('error', () => undefined);
      child.stdin.end(input);
    }

    const signal = (name: NodeJS.Signals) => {
      try {
        if (killGroup && child.pid) process.kill(-child.pid, name);
        else if (!exited) child.kill(name);
      } catch {
        // The group is gone (ESRCH): nothing of it is left to stop.
        try { if (!exited) child.kill(name); } catch { /* already gone */ }
      }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (graceTimer) clearTimeout(graceTimer);
      // Whoever still holds the pipes, this caller is done with them.
      child.stdout?.destroy();
      child.stderr?.destroy();
      // The child's group outlives it while a job it started is alive (its pgid is not reused then);
      // a group with no member left answers ESRCH, which signal() ignores.
      if (killGroup && child.pid) signal(timedOut ? 'SIGKILL' : 'SIGTERM');
      child.unref();
      resolve({ code: timedOut ? null : code, stdout: out.text(), stderr: err.text(), timedOut, error: startError });
    };
    const deadline = setTimeout(() => {
      // A child that already exited is not late: only its pipes are still open (the grace window).
      if (!exited) {
        timedOut = true;
        signal('SIGKILL');
      }
      finish();
    }, timeout);

    child.stdout?.on('data', out.add);
    child.stderr?.on('data', err.add);
    child.on('error', error => { startError = error; finish(); });
    child.on('exit', exitCode => {
      exited = true;
      code = exitCode;
      // close normally follows at once; a grandchild holding the pipe must not delay the answer.
      graceTimer = setTimeout(finish, exitGrace);
    });
    child.on('close', exitCode => {
      exited = true;
      if (code === null) code = exitCode;
      finish();
    });
  });
}

/**
 * Collects a stream's bytes up to `limit` and decodes them once, at the end: a UTF-8 character split
 * across two chunks arrives whole, and the limit counts bytes, as maxBuffer says.
 */
function collector(limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  return {
    add: (chunk: Buffer) => {
      if (size >= limit) return;
      const part = chunk.length > limit - size ? chunk.subarray(0, limit - size) : chunk;
      chunks.push(part);
      size += part.length;
    },
    text: () => Buffer.concat(chunks, size).toString('utf8'),
  };
}
