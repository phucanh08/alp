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
  // The executable uses the conpty.dll and OpenConsole.exe it embeds: with the system ConPTY, node-pty's
  // kill() forks a console-list helper through process.execPath, which there is alp.exe (it would refuse
  // the script and leave node-pty waiting 5 s). With the DLL, kill() ends the session by closing input.
  const spawnOptions = { name: options.name, cols: options.cols, rows: options.rows, cwd: options.cwd, env: options.env, useConpty: true, ...(packagedNodePty() ? { useConptyDll: true } : {}) };
  const child = typeof process.versions.bun === 'string' ? spawnUnderBun(pty, file, args, spawnOptions) : pty.spawn(file, args, spawnOptions);
  let killed = false;
  return {
    pid: child.pid,
    write(data: string) { if (!killed) child.write(data); },
    resize(cols: number, rows: number) { if (!killed) try { child.resize(cols, rows); } catch { /* exited */ } },
    // Best-effort: node-pty ends the ConPTY session and its shell; descendants are not guaranteed.
    kill() { if (killed) return; killed = true; try { child.kill(); } catch { /* already exited */ } },
    onData: listener => child.onData(listener),
    onExit: listener => child.onExit(({ exitCode, signal }) => listener({ exitCode, signal })),
  };
};

/**
 * The ALP executable runs on Bun (t-1e02), where node-pty's input stream, `new net.Socket({ fd })`
 * around the fd it opens on ConPTY's input pipe, takes the fd but never writes to it (output, read
 * by a worker, works; probed on windows-2022 with Bun 1.4.2). While node-pty spawns (synchronously),
 * hand it a small writer for that fd instead: the same calls node-pty makes on its input socket
 * (setEncoding, write, destroy, readable), with writes in order through fs.write and the fd closed
 * once on destroy.
 */
function spawnUnderBun(pty: NodePty, file: string, args: string[], options: Record<string, unknown>) {
  const load = createRequire(import.meta.url);
  const fs = load('node:fs') as typeof import('node:fs');
  const net = load('node:net') as { Socket: new (...args: unknown[]) => unknown };
  const Socket = net.Socket;
  function InputSocket(this: unknown, ...rest: unknown[]) {
    const [opts] = rest as [{ fd?: unknown; writable?: boolean; readable?: boolean } | undefined];
    if (opts && typeof opts.fd === 'number' && opts.writable === true && opts.readable === false) return fdWriter(fs, opts.fd);
    return new Socket(...rest);
  }
  InputSocket.prototype = Socket.prototype;
  net.Socket = InputSocket as unknown as typeof Socket;
  try { return pty.spawn(file, args, options); } finally { net.Socket = Socket; }
}

/** A write-only stand-in for net.Socket over a pipe fd: ordered writes, closed once; after a failed write it drops the rest. */
function fdWriter(fs: typeof import('node:fs'), fd: number) {
  let queue: Promise<void> = Promise.resolve();
  let closed = false;
  let failed = false;
  const writer = {
    readable: false,
    writable: true,
    setEncoding() { return writer; },
    write(data: string | Uint8Array) {
      if (closed || failed) return false;
      const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
      queue = queue.then(() => new Promise<void>(resolve => {
        const rest = (offset: number): void => {
          if (closed || failed || offset >= bytes.length) return resolve();
          fs.write(fd, bytes, offset, bytes.length - offset, null, (error, written) => {
            if (error) { failed = true; writer.writable = false; return resolve(); }
            rest(offset + written);
          });
        };
        rest(0);
      }));
      return true;
    },
    destroy() {
      if (closed) return writer;
      closed = true;
      writer.writable = false;
      void queue.then(() => fs.close(fd, () => {}));
      return writer;
    },
  };
  return writer;
}
