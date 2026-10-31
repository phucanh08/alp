/**
 * Windows terminals (best-effort, like Paseo/Orca): the platform PTY through node-pty (ConPTY).
 * There is no protection helper on Windows: closing a terminal kills its pty (node-pty `kill`),
 * which ends the shell; processes it started may keep running. Terminals report `protection: 'none'`.
 */
import { createRequire } from 'node:module';
import type { PtySpawn } from './terminals.js';

/** The node-pty surface the win32 owner uses. */
export type NodePty = { spawn(file: string, args: string[], options: Record<string, unknown>): {
  pid: number; write(data: string): void; resize(cols: number, rows: number): void; kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void }; onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
} };

let loaded: NodePty | null | undefined;
/** node-pty, or undefined when it cannot load on this host. */
export function loadNodePty(): NodePty | undefined {
  if (loaded === undefined) {
    try { loaded = createRequire(import.meta.url)('node-pty') as NodePty; } catch { loaded = null; }
  }
  return loaded ?? undefined;
}

/** `load` is a test hook (tests/windows-terminal.test.js); production loads the installed node-pty. */
export function windowsTerminalCapability(load: () => NodePty | undefined = loadNodePty): { available: boolean; protection?: 'none'; reason?: string } {
  return load() ? { available: true, protection: 'none' } : { available: false, reason: 'node_pty_unavailable' };
}

/** The shell for a Windows terminal: COMSPEC when absolute, else cmd.exe. */
export function windowsShell(env: NodeJS.ProcessEnv = process.env): string {
  const candidate = env.ComSpec ?? env.COMSPEC;
  return candidate && /^[a-zA-Z]:[\\/]/.test(candidate) ? candidate : 'cmd.exe';
}

/** The win32 owner over `load`'s node-pty; `load` is a test hook, production uses {@link windowsPtySpawn}. */
export const createWindowsPtySpawn = (load: () => NodePty | undefined = loadNodePty): PtySpawn => (file, args, options) => {
  if (options.signal?.aborted) throw new Error('Terminal startup cancelled');
  const pty = load();
  if (!pty) throw new Error('node-pty is unavailable on this host');
  const child = pty.spawn(file, args, { name: options.name, cols: options.cols, rows: options.rows, cwd: options.cwd, env: options.env, useConpty: true });
  let killed = false;
  return {
    // node-pty reports the ConPTY shell's pid only once its output worker connects (0 until then), so
    // the pid is read live rather than copied at spawn.
    get pid() { return child.pid; },
    write(data: string) { if (!killed) child.write(data); },
    resize(cols: number, rows: number) { if (!killed) try { child.resize(cols, rows); } catch { /* exited */ } },
    // Best-effort: node-pty ends the ConPTY session and its shell; descendants are not guaranteed.
    kill() { if (killed) return; killed = true; try { child.kill(); } catch { /* already exited */ } },
    onData: listener => child.onData(listener),
    onExit: listener => child.onExit(({ exitCode, signal }) => listener({ exitCode, signal })),
  };
};

export const windowsPtySpawn: PtySpawn = createWindowsPtySpawn();
