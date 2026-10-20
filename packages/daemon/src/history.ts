import { open, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import type { Envelope } from '@anhlp/alp-protocol/events';

/** Derived fixed-width index: offset, byte length, stable event cursor (three u64s).
 * A first-use migration scans once; subsequent pages seek at most limit index records
 * and at most maxBytes timeline bytes. Metadata commits the recoverable index prefix.
 */
const WIDTH = 24;
type Meta = { generation: string; secret: string; ino: number; bytes: number; count: number; tip: number };
export type HistoryItem = Envelope | { cursor: number; oversized: { bytes: number } };
export class HistoryError extends Error {
  constructor(public reason: 'invalid_cursor' | 'stale_cursor', message: string) { super(message); }
}
export function createHistoryIndex(file: string) {
  let pending: Promise<unknown> = Promise.resolve();
  const index = `${file}.idx`;
  const metadata = `${file}.history.json`;
  async function sync(): Promise<Meta> {
    const info = await stat(file).catch((error: any) => { if (error.code === 'ENOENT') return undefined; throw error; });
    let meta: Meta | undefined;
    try { meta = JSON.parse(await readFile(metadata, 'utf8')); } catch (error: any) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    if (meta && (!/^[0-9a-f]{32}$/.test(meta.generation) || !/^[0-9a-f]{64}$/.test(meta.secret) || ![meta.bytes, meta.count, meta.tip, meta.ino].every(value => Number.isSafeInteger(value) && value >= 0))) meta = undefined;
    const indexInfo = await stat(index).catch((error: any) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!meta || !indexInfo || indexInfo.size < meta.count * WIDTH || (meta.ino !== 0 && meta.ino !== (info?.ino ?? 0)) || meta.bytes > (info?.size ?? 0)) {
      meta = { generation: randomBytes(16).toString('hex'), secret: randomBytes(32).toString('hex'), ino: info?.ino ?? 0, bytes: 0, count: 0, tip: 0 };
      await writeFile(index, '', { mode: 0o600 });
    }
    if (meta.ino === 0 && info) meta.ino = info.ino;
    const handle = await open(index, 'a+', 0o600);
    try {
      await handle.truncate(meta.count * WIDTH);
      if (info && info.size > meta.bytes) {
        let offset = meta.bytes;
        let start = offset;
        let fragments: Buffer[] = [];
        for await (const raw of createReadStream(file, { start: offset, end: info.size - 1, highWaterMark: 65536 })) {
          const chunk = raw as Buffer;
          let from = 0;
          for (let at = 0; at < chunk.length; at++) if (chunk[at] === 10) {
            const part = chunk.subarray(from, at);
            fragments.push(part);
            const length = offset + at + 1 - start;
            let cursor = meta.tip + 1;
            const body = Buffer.concat(fragments).toString('utf8');
            try { const value = JSON.parse(body); if (Number.isSafeInteger(value.cursor) && value.cursor > meta.tip) cursor = value.cursor; }
            catch { throw new Error('Unreadable history line'); }
            const entry = Buffer.alloc(WIDTH);
            [start, length, cursor].forEach((value, i) => entry.writeBigUInt64LE(BigInt(value), i * 8));
            await handle.write(entry);
            meta.count++; meta.tip = cursor; meta.bytes = offset + at + 1;
            start = meta.bytes; fragments = []; from = at + 1;
          }
          const rest = chunk.subarray(from);
          fragments.push(rest);
          offset += chunk.length;
        }
      }
      const temporary = `${metadata}.tmp`;
      await writeFile(temporary, JSON.stringify(meta), { mode: 0o600 });
      await rename(temporary, metadata);
      return meta;
    } finally { await handle.close(); }
  }
  return {
    page(sessionId: string, options: { before?: string; limit?: number; maxBytes?: number } = {}) {
      const run = pending.then(async () => {
        const { before, limit = 200 } = options;
        if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('limit must be between 1 and 500');
        const maxBytes = Math.min(512 * 1024, options.maxBytes ?? 512 * 1024);
        if (maxBytes < 2048) throw new Error('history frame budget too small');
        const meta = await sync();
        const sign = (body: string) => createHmac('sha256', meta.secret).update(body).digest('base64url');
        let position = meta.count, tip = meta.tip;
        if (before !== undefined) {
          if (typeof before !== 'string' || before.length > 4096) throw new HistoryError('invalid_cursor', 'Invalid history cursor');
          try {
            const [body, signature, extra] = before.split('.');
            const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
            if (value.sessionId !== sessionId) throw new Error();
            if (value.generation !== meta.generation) throw new HistoryError('stale_cursor', 'History generation changed');
            const expected = Buffer.from(sign(body)); const received = Buffer.from(signature ?? '');
            if (extra || expected.length !== received.length || !timingSafeEqual(expected, received)) throw new Error();
            if (!Number.isSafeInteger(value.position) || value.position < 0 || value.position > meta.count || !Number.isSafeInteger(value.tip) || value.tip < 0 || value.tip > meta.tip) throw new Error();
            position = value.position; tip = value.tip;
          } catch (error) { if (error instanceof HistoryError) throw error; throw new HistoryError('invalid_cursor', 'Invalid history cursor'); }
        }
        const items: HistoryItem[] = [];
        let bytes = 1024;
        const idx = await open(index, 'r');
        const timeline = meta.count ? await open(file, 'r') : undefined;
        try {
          while (position > 0 && items.length < limit) {
            const entry = Buffer.alloc(WIDTH);
            if ((await idx.read(entry, 0, WIDTH, (position - 1) * WIDTH)).bytesRead !== WIDTH) throw new Error('Incomplete history index');
            const [offset, length, cursor] = [0, 8, 16].map(at => Number(entry.readBigUInt64LE(at)));
            let item: HistoryItem;
            if (length > maxBytes - 1024) item = { cursor, oversized: { bytes: length } };
            else {
              if (bytes + length > maxBytes) break;
              const data = Buffer.alloc(length);
              if ((await timeline!.read(data, 0, length, offset)).bytesRead !== length) throw new Error('History changed during read');
              item = { ...JSON.parse(data.toString('utf8')), cursor };
            }
            const size = Buffer.byteLength(JSON.stringify(item)) + 1;
            if (bytes + size > maxBytes) break;
            items.unshift(item); bytes += size; position--;
          }
        } finally { await idx.close(); await timeline?.close(); }
        const body = Buffer.from(JSON.stringify({ sessionId, generation: meta.generation, position, tip })).toString('base64url');
        return { generation: meta.generation, items, hasOlder: position > 0, ...(position > 0 ? { olderCursor: `${body}.${sign(body)}` } : {}), tipCursor: tip };
      });
      pending = run.catch(() => {});
      return run;
    },
  };
}
