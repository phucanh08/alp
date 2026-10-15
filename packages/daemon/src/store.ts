import { appendFile, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { replaceFile } from './lock.js';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { createLogger } from '@anhlp/alp-core/log';
import type { Envelope, SessionSnapshot, SessionSpec } from '@anhlp/alp-runtime/index';
import type { SessionError, SessionStatus } from '@anhlp/alp-protocol/session';

/**
 * alpd's durable state (plans/reference/ALPD.md §5, §66): one JSON record per session,
 * written atomically, one append-only JSONL timeline per tree, and one receipt per
 * delivered prompt. Writes survive a crash of the alpd process once their promise
 * resolves; nothing is fsynced, so a power loss or a failing disk may lose recent writes.
 */

// The session lifecycle and the error shape are neutral (ALPD §18): the protocol owns them so
// viewers and integrations speak one language. Re-exported here to keep the daemon's API stable.
export type { SessionError, SessionStatus } from '@anhlp/alp-protocol/session';

export type SessionRecord = {
  version: 1;
  id: string;
  rootId: string;
  /** The client's request, kept for roots so they can be resumed. */
  spec?: SessionSpec;
  delegation?: boolean;
  session?: SessionSnapshot;
  status: SessionStatus;
  lastError?: SessionError;
  title?: string;
  /** Set aside by the user: closed, and listed only when asked (ALPD §61). */
  archived?: boolean;
  createdAt: string;
  updatedAt: string;
};

/**
 * Delivery of one clientMessageId; `pending` means alpd may have stopped while sending it.
 * A completed receipt says what the runtime answered: `unknown` when the provider may or
 * may not have the message (its process died or timed out mid-request).
 */
export type Receipt = {
  version: 1;
  sessionId: string;
  clientMessageId: string;
  fingerprint: string;
  state: 'pending' | 'completed';
  outcome?: 'accepted' | 'failed' | 'unknown';
  error?: { message: string; code?: string };
  /** Completed at the next start from the tree's timeline, not by the delivery itself. */
  reconciled?: boolean;
  updatedAt: string;
};

/** A receipt file that exists but cannot be read as one: its delivery's outcome is unknown. */
export type UnreadableReceipt = { version: 1; state: 'unreadable' };

/** Failed writes since alpd started; `ok` until the first one (ALPD §66). */
export type StoreHealth = { ok: boolean; failures: number; lastError?: { at: string; operation: string; message: string } };

const log = createLogger({ component: 'store' });

const SAFE = /[^\w.:-]/g;
const fileName = (id: string) => id.replace(SAFE, '_');
const TAIL_CHUNK = 64 * 1024;

export type Store = ReturnType<typeof createStore>;

export function createStore(root: string) {
  const sessionsDir = path.join(root, 'sessions');
  const timelineDir = path.join(root, 'timeline');
  const receiptsDir = path.join(root, 'receipts');
  const writes = new Map<string, Promise<void>>();
  const appends = new Map<string, Promise<void>>();
  /** Keys whose last write failed (records, receipts) or that lost any append (timelines). */
  const failed = new Map<string, Error>();
  /** Timelines whose tail this process has checked for a line a crash cut short. */
  const repaired = new Set<string>();
  const health: StoreHealth = { ok: true, failures: 0 };
  let ready: Promise<void> | undefined;
  const prepare = () => ready ??= Promise.all([
    mkdir(sessionsDir, { recursive: true, mode: 0o700 }),
    mkdir(timelineDir, { recursive: true, mode: 0o700 }),
    mkdir(receiptsDir, { recursive: true, mode: 0o700 }),
  ]).then(() => {}, error => { ready = undefined; throw error; });

  async function writeAtomic(file: string, body: string) {
    const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(temporary, body, { mode: 0o600 });
      await replaceFile(temporary, file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  /**
   * Serializes work per key so a later write never lands before an earlier one. The
   * returned promise rejects when the write fails; the queue itself goes on.
   */
  function queue(map: Map<string, Promise<void>>, key: string, operation: string, work: () => Promise<void>, sticky = false, ids: { sessionId?: string; rootId?: string; clientMessageId?: string } = {}) {
    const next = (map.get(key) ?? Promise.resolve()).then(prepare).then(work);
    const failure = map === appends ? `timeline:${key}` : key;
    const settled = next.then(
      () => { if (!sticky) failed.delete(failure); },
      error => {
        failed.set(failure, error);
        health.ok = false;
        health.failures++;
        health.lastError = { at: new Date().toISOString(), operation, message: error?.message ?? String(error) };
        log.error(`${operation} failed`, { code: 'ALP_PERSISTENCE_WRITE_FAILED', operation, error, ...ids });
      });
    map.set(key, settled);
    void settled.then(() => { if (map.get(key) === settled) map.delete(key); });
    return next;
  }

  /**
   * A crash during an append can leave a timeline's last line cut short. Before this
   * process appends to it, a cut line is removed, or completed when it parses whole,
   * so the next line does not run into it.
   */
  async function repairTail(file: string) {
    const handle = await open(file, 'r+').catch((error: any) => { if (error?.code === 'ENOENT') return undefined; throw error; });
    if (!handle) return;
    try {
      const { size } = await handle.stat();
      if (!size) return;
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      if (last[0] === 0x0a) return;
      let start = 0;
      for (let end = size; end > 0 && !start; end -= TAIL_CHUNK) {
        const from = Math.max(0, end - TAIL_CHUNK);
        const chunk = Buffer.alloc(end - from);
        await handle.read(chunk, 0, chunk.length, from);
        const newline = chunk.lastIndexOf(0x0a);
        if (newline >= 0) start = from + newline + 1;
      }
      const tail = Buffer.alloc(size - start);
      await handle.read(tail, 0, tail.length, start);
      let whole = false;
      try { JSON.parse(tail.toString('utf8')); whole = true; } catch {}
      if (whole) await handle.write('\n', size);
      else await handle.truncate(start);
      log.warn(`${whole ? 'completed' : 'removed'} a timeline line cut short in ${path.basename(file)} (${tail.length} bytes)`, { code: 'ALP_TIMELINE_REPAIRED', file: path.basename(file), bytes: tail.length });
    } finally {
      await handle.close();
    }
  }

  /** Envelopes of a timeline text; lines without a cursor (written before cursors) count from the previous one. */
  function parseTimeline(text: string, name: string): Envelope[] {
    const envelopes: Envelope[] = [];
    let cursor = 0;
    let skipped = 0;
    for (const line of text.split('\n')) {
      if (!line) continue;
      let envelope: Envelope;
      try { envelope = JSON.parse(line); } catch { skipped++; continue; }
      cursor = typeof envelope.cursor === 'number' && envelope.cursor > cursor ? envelope.cursor : cursor + 1;
      envelopes.push({ ...envelope, cursor });
    }
    if (skipped) log.warn(`skipped ${skipped} unreadable timeline lines in ${name}`, { code: 'ALP_TIMELINE_UNREADABLE', file: name, skipped });
    return envelopes;
  }

  const receiptFile = (key: string) => path.join(receiptsDir, `${fileName(key)}.json`);

  return {
    put(record: SessionRecord) {
      const file = path.join(sessionsDir, `${fileName(record.id)}.json`);
      const body = JSON.stringify(record);
      return queue(writes, record.id, `record ${record.id}`, () => writeAtomic(file, body), false, { sessionId: record.id, rootId: record.rootId });
    },

    async receipt(key: string): Promise<Receipt | UnreadableReceipt | undefined> {
      await writes.get(`receipt:${key}`);
      let text: string;
      try {
        text = await readFile(receiptFile(key), 'utf8');
      } catch (error: any) {
        if (error?.code === 'ENOENT') return undefined;
        throw error;
      }
      try {
        const receipt = JSON.parse(text);
        if (receipt?.version === 1 && typeof receipt.fingerprint === 'string' && (receipt.state === 'pending' || receipt.state === 'completed')) return receipt;
      } catch {}
      return { version: 1, state: 'unreadable' };
    },

    putReceipt(key: string, receipt: Receipt) {
      const body = JSON.stringify(receipt);
      return queue(writes, `receipt:${key}`, `receipt ${receipt.clientMessageId}`, () => writeAtomic(receiptFile(key), body), false, { sessionId: receipt.sessionId, clientMessageId: receipt.clientMessageId });
    },

    removeReceipt(key: string) {
      return queue(writes, `receipt:${key}`, `receipt removal ${key}`, () => rm(receiptFile(key), { force: true }));
    },

    /** Every readable receipt with its key and when its file was last written. */
    async receipts(): Promise<Array<{ key: string; receipt: Receipt; writtenAt: number }>> {
      await prepare();
      const found: Array<{ key: string; receipt: Receipt; writtenAt: number }> = [];
      for (const name of await readdir(receiptsDir)) {
        if (!name.endsWith('.json')) continue;
        const key = name.slice(0, -'.json'.length);
        try {
          const file = path.join(receiptsDir, name);
          const receipt = JSON.parse(await readFile(file, 'utf8'));
          if (receipt?.version === 1 && typeof receipt.sessionId === 'string') found.push({ key, receipt, writtenAt: (await stat(file)).mtimeMs });
        } catch {}
      }
      return found;
    },

    /** When the newest of these records' files was written (a restore writes them anew); 0 when none is there. */
    async writtenAt(ids: string[]) {
      let newest = 0;
      for (const id of ids) newest = Math.max(newest, await stat(path.join(sessionsDir, `${fileName(id)}.json`)).then(info => info.mtimeMs, () => 0));
      return newest;
    },

    /**
     * Deletes receipts not written for `maxAgeMs` and, with `temporaries` (only at start, when no
     * write can be under way), temporary files a crash left behind.
     */
    async pruneReceipts(maxAgeMs: number, { temporaries = true } = {}) {
      await prepare();
      const now = Date.now();
      for (const directory of [sessionsDir, receiptsDir]) {
        for (const name of await readdir(directory)) {
          const file = path.join(directory, name);
          if (name.endsWith('.tmp')) { if (temporaries) await rm(file, { force: true }); continue; }
          if (directory !== receiptsDir) continue;
          const info = await stat(file).catch(() => undefined);
          if (info && now - info.mtimeMs > maxAgeMs) await rm(file, { force: true });
        }
      }
    },

    async list(): Promise<SessionRecord[]> {
      await prepare();
      const records: SessionRecord[] = [];
      for (const name of await readdir(sessionsDir)) {
        if (!name.endsWith('.json')) continue;
        try {
          const record = JSON.parse(await readFile(path.join(sessionsDir, name), 'utf8'));
          if (record?.version === 1 && typeof record.id === 'string') records.push(record);
          else log.warn(`skipped invalid record ${name}`, { code: 'ALP_RECORD_UNREADABLE', file: name });
        } catch {
          log.warn(`skipped unreadable record ${name}`, { code: 'ALP_RECORD_UNREADABLE', file: name });
        }
      }
      return records;
    },

    append(rootId: string, envelope: Envelope) {
      const file = path.join(timelineDir, `${fileName(rootId)}.jsonl`);
      const line = `${JSON.stringify(envelope)}\n`;
      // A lost line leaves a gap in the timeline for good, so a timeline stays failed once it lost one.
      return queue(appends, rootId, `timeline ${rootId}`, async () => {
        if (!repaired.has(rootId)) { await repairTail(file); repaired.add(rootId); }
        await appendFile(file, line, { mode: 0o600 });
      }, true, { rootId });
    },

    async timeline(rootId: string): Promise<Envelope[]> {
      await appends.get(rootId);
      const name = `${fileName(rootId)}.jsonl`;
      try {
        return parseTimeline(await readFile(path.join(timelineDir, name), 'utf8'), name);
      } catch (error: any) {
        if (error?.code === 'ENOENT') return [];
        throw error;
      }
    },

    /**
     * Waits for the queued writes of these records and timelines, and names those that
     * failed: a record whose last write failed, or a timeline that lost a line.
     */
    async drain({ records = [] as string[], timelines = [] as string[] }) {
      await Promise.all([...records.map(id => writes.get(id)), ...timelines.map(id => appends.get(id))]);
      return [...records.filter(id => failed.has(id)), ...timelines.filter(id => failed.has(`timeline:${id}`))];
    },

    /**
     * Whether the state directory can be read and written right now: a small file is written,
     * read back and removed. `StoreHealth` only says what failed since alpd started.
     */
    async probe(): Promise<{ ok: boolean; code?: string; message?: string }> {
      const file = path.join(root, `.probe-${process.pid}-${randomBytes(3).toString('hex')}.tmp`);
      const token = randomBytes(8).toString('hex');
      let step: 'write' | 'read' = 'write';
      try {
        await prepare();
        await writeFile(file, token, { mode: 0o600 });
        step = 'read';
        if (await readFile(file, 'utf8') !== token) throw new Error('what was written is not what was read back');
        return { ok: true };
      } catch (error: any) {
        return { ok: false, code: step === 'write' ? 'ALP_STATE_NOT_WRITABLE' : 'ALP_STATE_NOT_READABLE', message: `${error?.code ? `${error.code}: ` : ''}${error?.message ?? error}` };
      } finally {
        await rm(file, { force: true }).catch(() => {});
      }
    },

    /** How many records, receipts and timelines are failed now: a later successful write clears a record, a lost timeline line never clears. */
    failing() {
      return failed.size;
    },

    health(): StoreHealth {
      return { ...health, ...(health.lastError ? { lastError: { ...health.lastError } } : {}) };
    },

    /** Removes a whole tree: its records and its timeline. */
    async remove(rootId: string, ids: string[]) {
      await Promise.all([...ids.map(id => writes.get(id)), appends.get(rootId)]);
      await Promise.all([
        ...ids.map(id => rm(path.join(sessionsDir, `${fileName(id)}.json`), { force: true })),
        rm(path.join(timelineDir, `${fileName(rootId)}.jsonl`), { force: true }),
      ]);
      for (const id of ids) failed.delete(id);
      failed.delete(`timeline:${rootId}`);
      repaired.delete(rootId);
    },

    async flush() {
      await Promise.all([...writes.values(), ...appends.values()]);
    },
  };
}
