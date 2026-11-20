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
  /** True when the deadline was reached. */
  timedOut: boolean;
  /** Why the child could not start (ENOENT, EACCES…). */
  error?: Error;
};

export type RunOptions = {
  env: NodeJS.ProcessEnv;
  timeout: number;
  /** How long to wait for stdio to close after the child exits; a grandchild may hold it open. */
  exitGrace?: number;
  /** Kill the child's whole process group at the deadline (the child is started in its own group). */
  killGroup?: boolean;
  maxBuffer?: number;
};

export function run(file: string, args: string[], options: RunOptions): Promise<RunResult> {
  const { env, timeout, exitGrace = 500, killGroup = false, maxBuffer = 1 << 20 } = options;
  return new Promise<RunResult>(resolve => {
    let stdout = '';
    let stderr = '';
    let code: number | null = null;
    let settled = false;
    let timedOut = false;
    let startError: Error | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const child = spawn(file, args, { env, shell: false, windowsHide: true, detached: killGroup, stdio: ['ignore', 'pipe', 'pipe'] });

    const kill = () => {
      try {
        if (killGroup && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
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
      if (killGroup && child.pid && child.exitCode === null && child.signalCode === null) kill();
      child.unref();
      resolve({ code: timedOut ? null : code, stdout, stderr, timedOut, error: startError });
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      kill();
      finish();
    }, timeout);

    // setEncoding decodes through a StringDecoder, so a UTF-8 character split across two chunks
    // arrives whole instead of as two replacement characters.
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    const append = (which: 'stdout' | 'stderr') => (chunk: string) => {
      if (which === 'stdout') stdout = (stdout + chunk).slice(0, maxBuffer);
      else stderr = (stderr + chunk).slice(0, maxBuffer);
    };
    child.stdout?.on('data', append('stdout'));
    child.stderr?.on('data', append('stderr'));
    child.on('error', error => { startError = error; finish(); });
    child.on('exit', exitCode => {
      code = exitCode;
      // close normally follows at once; a grandchild holding the pipe must not delay the answer.
      graceTimer = setTimeout(finish, exitGrace);
    });
    child.on('close', exitCode => {
      if (code === null) code = exitCode;
      finish();
    });
  });
}
