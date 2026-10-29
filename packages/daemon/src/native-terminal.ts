/** Identity-bound native PTY owner; shipped helper only, never runtime compilation. */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
export type CleanupResult = { observed: number; live: number; uncertain: number };
type Exit = { exitCode: number | null; signal?: number };
type Listener<T> = (event: T) => void;
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
function binary() {
  const libc = process.platform === 'linux' ? (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } })?.header?.glibcVersionRuntime ? 'glibc' : 'musl' : undefined;
  const slot = [process.platform, process.arch, libc].filter(Boolean).join('-');
  const adjacent = path.join(path.dirname(fileURLToPath(import.meta.url)), 'terminal-native');
  const dir = existsSync(adjacent) ? adjacent : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../native');
  const file = path.join(dir, 'prebuilt', slot, 'terminal-owner');
  const manifest = JSON.parse(readFileSync(path.join(path.dirname(file), 'manifest.json'), 'utf8'));
  if (!statSync(file).isFile() || manifest.protocol !== 1 || manifest.slot !== slot || manifest.source !== sha(readFileSync(path.join(dir, 'terminal-owner.c'))) || manifest.sha256 !== sha(readFileSync(file))) throw new Error('Native helper manifest mismatch');
  return file;
}
export function nativeTerminalCapability(): { available: boolean; reason?: string } {
  try {
    const probe = spawnSync(binary(), ['--capability'], { encoding: 'utf8', timeout: 2_000, maxBuffer: 4096 });
    return probe.status === 0 && probe.stdout.trim() === 'alp-terminal-owner:1' ? { available: true } : { available: false, reason: 'native_capability_unavailable' };
  } catch { return { available: false, reason: 'native_prebuilt_unavailable' }; }
}
export async function nativePtySpawn(file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string>; killGraceMs?: number; signal?: AbortSignal }) {
  if (options.signal?.aborted) throw new Error('Native terminal startup cancelled');
  const child = spawn(binary(), [String(options.cols), String(options.rows), String(options.killGraceMs ?? 1000), options.cwd, file, ...args], { env: options.env, stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] });
  const control = child.stdio[4] as import('node:stream').Writable;
  const events = child.stdio[3] as import('node:stream').Readable;
  const data = new Set<Listener<string>>(), exits = new Set<Listener<Exit>>();
  const decoder = new StringDecoder('utf8'); let buffered = '', protocol = '', exit: Exit | undefined, pid = 0;
  let readyResolve!: () => void, readyReject!: (error: Error) => void, finish!: (result: CleanupResult) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const finished = new Promise<CleanupResult>(resolve => { finish = resolve; });
  let result: CleanupResult | undefined, completed = false, closing = false;
  let controlBlocked = false, pendingResize: string | undefined;
  const resizeCommand = (command: string) => {
    if (closing || result) return;
    if (controlBlocked) { pendingResize = command; return; }
    controlBlocked = !control.write(command);
  };
  control.on('drain', () => {
    controlBlocked = false;
    const next = pendingResize; pendingResize = undefined;
    if (next) resizeCommand(next);
  });
  const closeOwner = () => {
    if (closing || result) return;
    closing = true; pendingResize = undefined;
    // No queue of resizes can stand ahead of cleanup: closing fd4 wakes native POLLHUP.
    control.destroy(); child.stdin?.end();
  };
  const fail = (reason: string) => {
    readyReject(new Error(reason));
    // No bare child PID signaling. Closing owner input/control asks native bound cleanup.
    closeOwner();
  };
  const timer = setTimeout(() => fail('Native terminal startup timed out'), 5000);
  const complete = (value: CleanupResult) => { if (!completed) { completed = true; result = value; finish(value); } };
  child.on('error', error => { fail(error.message); complete({ observed: 0, live: 0, uncertain: 1 }); });
  child.on('close', () => {
    clearTimeout(timer);
    if (!pid) readyReject(new Error('Native terminal refused startup'));
    // close follows every stdio end: service exit disposal cannot discard trailing PTY output.
    exit ??= { exitCode: null };
    for (const listener of exits) listener(exit);
    complete(result ?? { observed: 0, live: 0, uncertain: 1 });
  });
  child.stderr?.resume();
  // Pipes may fail after native exit. Native protocol/close supplies the authoritative outcome.
  child.stdin?.on('error', () => {}); control.on('error', () => {});
  child.stdout?.on('data', (chunk: Buffer) => {
    const text = decoder.write(chunk);
    if (data.size) for (const listener of data) listener(text);
    else if (Buffer.byteLength(buffered) + Buffer.byteLength(text) <= 1024*1024) buffered += text;
    else fail('Native terminal output limit exceeded');
  });
  events.on('data', (chunk: Buffer) => {
    protocol += chunk.toString('utf8');
    if (protocol.length > 8192) { fail('Invalid native protocol'); return; }
    let newline;
    while ((newline = protocol.indexOf('\n')) >= 0) {
      const line = protocol.slice(0, newline); protocol = protocol.slice(newline + 1);
      try {
        const value = JSON.parse(line);
        if (value.ready && value.protocol === 1 && Number.isSafeInteger(value.ready) && value.ready > 1) { pid = value.ready; clearTimeout(timer); readyResolve(); }
        else if ('exitCode' in value) { exit = { exitCode: value.exitCode, signal: value.signal }; }
        else if (value.cleanup === true && ['observed', 'live', 'uncertain'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)) result = value;
        else if (value.error) fail(String(value.error));
        else fail('Invalid native event');
      } catch { fail('Invalid native JSON'); }
    }
  });
  const abort = () => fail('Native terminal startup cancelled');
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  try { await ready; } catch (error) { const cleanupResult = await finished; throw Object.assign(error instanceof Error ? error : new Error(String(error)), { cleanupResult }); }
  finally { options.signal?.removeEventListener('abort', abort); }
  return {
    pid,
    write(value: string) { if (closing || result) return; if ((child.stdin?.writableLength ?? 0) + Buffer.byteLength(value) > 1024*1024) { fail('Native input limit exceeded'); return; } child.stdin?.write(value); },
    resize(cols: number, rows: number) { if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && cols <= 1000 && rows > 0 && rows <= 1000) resizeCommand(`R ${cols} ${rows}\n`); },
    kill() { closeOwner(); },
    cleanup() { closeOwner(); return finished; },
    onData(listener: Listener<string>) { data.add(listener); if (buffered) { const value = buffered; buffered = ''; queueMicrotask(() => { if (data.has(listener)) listener(value); }); } return { dispose() { data.delete(listener); } }; },
    onExit(listener: Listener<Exit>) { exits.add(listener); if (exit && completed) { const value = exit; queueMicrotask(() => { if (exits.has(listener)) listener(value); }); } return { dispose() { exits.delete(listener); } }; },
  };
}
