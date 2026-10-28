import headless from '@xterm/headless';
import { ERROR } from '@anhlp/alp-protocol';
import { RpcError } from './rpc-error.js';

// Exact xterm 6.0.0, also used by Paseo 0.12. No raw replay reconstruction: one parser from spawn.
// Bound both queued work and lifetime input (including OSC/combining payloads hidden from rows).
export const SCREEN_LIMITS = Object.freeze({ scrollback: 1000, pendingBytes: 1024 * 1024, pendingOperations: 256, inputBytes: 8 * 1024 * 1024, resultBytes: 1024 * 1024, retained: 16 });
export class TerminalScreen {
  #term: InstanceType<typeof headless.Terminal> | undefined;
  #pending = 0;
  #input = 0;
  #operations = 0;
  #waiters = new Set<() => void>();
  constructor(cols: number, rows: number) {
    this.#term = new headless.Terminal({ cols, rows, scrollback: SCREEN_LIMITS.scrollback, allowProposedApi: true, logLevel: 'off' });
  }
  get available() { return this.#term !== undefined; }
  #unavailable() { return new RpcError(ERROR.unavailable, 'Terminal capture is unavailable: its bounded screen was released or exceeded its resource limit', { reason: 'terminal_capture_unavailable' }); }
  #queue(term: InstanceType<typeof headless.Terminal>, data: string, callback: () => void) {
    if (this.#operations >= SCREEN_LIMITS.pendingOperations) { this.dispose(); return; }
    this.#operations++;
    try {
      term.write(data, () => { this.#operations--; callback(); });
    } catch { this.#operations--; this.dispose(); }
  }
  write(data: string) {
    const term = this.#term;
    if (!term) return;
    const bytes = Buffer.byteLength(data);
    this.#input += bytes;
    if (this.#input > SCREEN_LIMITS.inputBytes || this.#pending + bytes > SCREEN_LIMITS.pendingBytes) { this.dispose(); return; }
    this.#pending += bytes;
    this.#queue(term, data, () => { this.#pending -= bytes; });
  }
  resize(cols: number, rows: number) {
    const term = this.#term;
    // Keep resize between the old output and output caused by the new PTY size.
    if (term) this.#queue(term, '', () => { if (this.#term === term) term.resize(cols, rows); });
  }
  capture(options: { start?: number; end?: number; stripAnsi?: boolean } = {}): Promise<{ lines: string[]; totalLines: number }> {
    const term = this.#term;
    if (!term) return Promise.reject(this.#unavailable());
    return new Promise((resolve, reject) => {
      const released = () => reject(this.#unavailable());
      this.#waiters.add(released);
      // The callback is a parser barrier, not a delay or a ring-buffer approximation.
      this.#queue(term, '', () => {
        this.#waiters.delete(released);
        if (this.#term !== term) { reject(this.#unavailable()); return; }
        const buffer = term.buffer.active;
        const totalLines = buffer.length;
        const index = (value: number | undefined, fallback: number) => value === undefined ? fallback : Math.max(0, Math.min(totalLines - 1, value < 0 ? totalLines + value : value));
        const start = index(options.start, 0);
        const end = index(options.end, totalLines - 1);
        const lines: string[] = [];
        let bytes = 0;
        for (let i = start; i <= end; i++) {
          // Cell text, like Paseo: styling escapes are not regenerated when stripAnsi=false.
          const line = buffer.getLine(i)?.translateToString(true).trimEnd() ?? '';
          bytes += Buffer.byteLength(JSON.stringify(line)) + 1;
          if (bytes > SCREEN_LIMITS.resultBytes - 128) { reject(new RpcError(ERROR.unavailable, 'Terminal capture exceeds the response limit; select a smaller line range', { reason: 'terminal_capture_too_large' })); return; }
          lines.push(line);
        }
        resolve({ lines, totalLines });
      });
    });
  }
  dispose() {
    this.#term?.dispose();
    this.#term = undefined;
    for (const waiter of this.#waiters) waiter();
    this.#waiters.clear();
  }
}
