/**
 * Windows terminals (best-effort, like Paseo/Orca): the platform PTY through node-pty (ConPTY).
 * There is no protection helper on Windows: closing a terminal kills its pty (node-pty `kill`),
 * which ends the shell; processes it started may keep running. Terminals report `protection: 'none'`.
 */
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { PtySpawn } from './terminals.js';

type NodePty = { spawn(file: string, args: string[], options: Record<string, unknown>): {
  pid: number; write(data: string): void; resize(cols: number, rows: number): void; kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void }; onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
} };

/**
 * In the ALP executable (t-1e02) node-pty is not in node_modules: the build embeds its JavaScript and
 * the win32 prebuilt (conpty.node, conpty/conpty.dll, OpenConsole.exe), extracted with the other
 * assets. registerPackaged publishes assetDir on globalThis; read it there so this adapter needs no package import.
 */
function packagedNodePty(): string | undefined {
  const assets = (globalThis as { [key: symbol]: { assetDir?: () => string | undefined } | undefined })[Symbol.for('alp.packaged')]?.assetDir?.();
  const entry = assets ? path.join(assets, 'node-pty', 'lib', 'index.js') : undefined;
  return entry && existsSync(entry) ? entry : undefined;
}

let loaded: NodePty | null | undefined;
/** node-pty, or undefined when it cannot load on this host. */
export function loadNodePty(): NodePty | undefined {
  if (loaded === undefined) {
    try { loaded = createRequire(import.meta.url)(packagedNodePty() ?? 'node-pty') as NodePty; } catch { loaded = null; }
  }
  return loaded ?? undefined;
}

export function windowsTerminalCapability(): { available: boolean; protection?: 'none'; reason?: string } {
  return loadNodePty() ? { available: true, protection: 'none' } : { available: false, reason: 'node_pty_unavailable' };
}

/** The shell for a Windows terminal: COMSPEC when absolute, else cmd.exe. */
export function windowsShell(env: NodeJS.ProcessEnv = process.env): string {
  const candidate = env.ComSpec ?? env.COMSPEC;
  return candidate && /^[a-zA-Z]:[\\/]/.test(candidate) ? candidate : 'cmd.exe';
}

export const windowsPtySpawn: PtySpawn = (file, args, options) => {
  if (options.signal?.aborted) throw new Error('Terminal startup cancelled');
  const pty = loadNodePty();
  if (!pty) throw new Error('node-pty is unavailable on this host');
  const spawnOptions = { name: options.name, cols: options.cols, rows: options.rows, cwd: options.cwd, env: options.env, useConpty: true };
  const { child, write } = typeof process.versions.bun === 'string' ? spawnUnderBun(pty, file, args, spawnOptions) : { child: pty.spawn(file, args, spawnOptions), write: undefined };
  let killed = false;
  return {
    pid: child.pid,
    write(data: string) { if (!killed) (write ?? (text => child.write(text)))(data); },
    resize(cols: number, rows: number) { if (!killed) try { child.resize(cols, rows); } catch { /* exited */ } },
    // Best-effort: node-pty ends the ConPTY session and its shell; descendants are not guaranteed.
    kill() { if (killed) return; killed = true; try { child.kill(); } catch { /* already exited */ } },
    onData: listener => child.onData(listener),
    onExit: listener => child.onExit(({ exitCode, signal }) => listener({ exitCode, signal })),
  };
};

/**
 * The ALP executable runs on Bun (t-1e02), where node-pty's input stream, a net.Socket around the fd
 * it opens on ConPTY's input pipe, accepts writes but never delivers them (output, read by a worker,
 * works). Capture that fd while node-pty opens it, synchronously inside spawn, and write the input
 * to it directly, in order. The fd stays node-pty's: closing the terminal releases it with its socket.
 */
function spawnUnderBun(pty: NodePty, file: string, args: string[], options: Record<string, unknown>) {
  const fs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
  const open = fs.openSync;
  let conin: number | undefined;
  (fs as { openSync: typeof open }).openSync = ((target: import('node:fs').PathLike, flags?: import('node:fs').OpenMode, mode?: import('node:fs').Mode | null) => {
    const fd = open(target, flags ?? 'r', mode);
    if (typeof target === 'string' && flags === 'w' && /^\\\\[.?]\\pipe\\/i.test(target)) conin = fd;
    return fd;
  }) as typeof open;
  let child: ReturnType<NodePty['spawn']>;
  try { child = pty.spawn(file, args, options); } finally { (fs as { openSync: typeof open }).openSync = open; }
  if (conin === undefined) return { child, write: undefined };
  const fd = conin;
  let queue: Promise<void> = Promise.resolve();
  const write = (data: string) => {
    const bytes = Buffer.from(data, 'utf8');
    queue = queue.then(() => new Promise<void>(resolve => {
      const rest = (offset: number): void => {
        if (offset >= bytes.length) return resolve();
        fs.write(fd, bytes, offset, bytes.length - offset, null, (error, written) => error ? resolve() : rest(offset + written));
      };
      rest(0);
    }));
  };
  return { child, write };
}
