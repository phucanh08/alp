import { createHash, randomUUID } from 'node:crypto';
import { lstat, open, readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { assertPrivateDirectory } from '@anhlp/alp-client/index';
import { writeAtomic } from '@anhlp/alp-core/atomic';

/** Same sorted JSON fingerprint as the sole registry owner; arrays retain their order. */
export const creationDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v)).digest('hex');

export type CreationState = { phase?: string; sessionId?: string; messageId?: string; workspaceId?: string; agentId?: string; error?: string };
export type CreationAttempt = { state: CreationState; checkpoint(patch: CreationState): Promise<void> };
type Receipt = { fingerprint: string; files: boolean; epoch: string; state: CreationState };
type Journal = { version: 1; scope: 'paseo-shared-owner'; receipts: Record<string, Receipt> };
const empty = (): Journal => ({ version: 1, scope: 'paseo-shared-owner', receipts: {} });
const MAX_BYTES = 8 * 1024 * 1024;

/** A private single-writer write-ahead journal. No eviction: forgetting an uncertain key permits duplicates. */
export function createCreationReceipts(home?: string, { limit = 4096, write = writeAtomic } = {}) {
  const epoch = randomUUID(), directory = home ? path.join(home, 'state', 'paseo-create') : undefined;
  const file = directory && path.join(directory, 'receipts.json'), lockFile = directory && path.join(directory, 'writer.lock');
  let journal: Journal, started: Promise<void> | undefined, closing = false, lockText: string | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  const pending = new Map<string, { fingerprint: string; promise: Promise<any> }>();
  const serial = <T>(fn: () => Promise<T>) => { const result = tail.then(fn); tail = result.catch(() => {}); return result; };
  async function privatePath(target: string, dir: boolean) {
    const info = await lstat(target);
    if (info.isSymbolicLink() || (dir ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077)) throw new Error('Creation journal must be private to this OS user');
    return info;
  }
  async function acquire() {
    if (!directory || !lockFile) return;
    await assertPrivateDirectory(home!, { create: true });
    await assertPrivateDirectory(path.join(home!, 'state'), { create: true });
    await assertPrivateDirectory(directory, { create: true });
    let handle;
    try { handle = await open(lockFile, 'wx', 0o600); }
    catch (e: any) { if (e.code === 'EEXIST') throw new Error('Creation journal writer lock exists; stop all facade writers before removing only writer.lock for recovery'); throw e; }
    const value = JSON.stringify({ version: 1, pid: process.pid, nonce: epoch });
    try { await handle.writeFile(value); lockText = value; } finally { await handle.close(); }
    // Only our recognized temporary files, after exclusive ownership. No receipt is pruned.
    for (const name of await readdir(directory)) if (/^receipts\.json\.\d+\.[a-f0-9]{8}\.tmp$/.test(name)) await unlink(path.join(directory, name));
  }
  async function start() {
    started ??= (async () => {
      await acquire();
      if (!file) { journal = empty(); return; }
      try {
        const info = await privatePath(file, false);
        if (info.size > MAX_BYTES) throw new Error('Creation journal is too large');
        const value = JSON.parse(await readFile(file, 'utf8'));
        if (value.version !== 1 || value.scope !== 'paseo-shared-owner' || !value.receipts || Array.isArray(value.receipts) || typeof value.receipts !== 'object' || Object.keys(value.receipts).length > limit) throw new Error('Unsupported creation journal');
        for (const [key, row] of Object.entries(value.receipts) as [string, Receipt][]) {
          if (!/^[a-f0-9]{64}$/.test(key) || !row || !/^[a-f0-9]{64}$/.test(row.fingerprint) || typeof row.files !== 'boolean' || typeof row.epoch !== 'string' || !row.state || typeof row.state !== 'object' || Array.isArray(row.state) || Object.entries(row.state).some(([key, v]) => !['phase', 'sessionId', 'messageId', 'workspaceId', 'agentId', 'error'].includes(key) || typeof v !== 'string')) throw new Error('Corrupt creation journal');
        }
        journal = value;
      } catch (e: any) { if (e.code === 'ENOENT') journal = empty(); else throw new Error(`Creation journal cannot be read safely: ${e.message}`); }
    })();
    return started;
  }
  async function persist(next: Journal) {
    const text = JSON.stringify(next);
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Creation journal is full; existing receipts must be retained');
    if (file) {
      await write(file, text, 0o600);
    }
    journal = next;
  }
  return {
    run<T>(kind: string, identity: string, intent: unknown, files: boolean, operation: (state: CreationState, checkpoint: (patch: CreationState) => Promise<void>) => Promise<T>): Promise<T> {
      if (closing) return Promise.reject(new Error('Creation journal is closing'));
      if (!identity || Buffer.byteLength(identity) > 512) return Promise.reject(new Error('A creation request identity of at most 512 bytes is required'));
      const key = creationDigest([kind, identity]), fingerprint = creationDigest(intent);
      const current = pending.get(key);
      if (current) return current.fingerprint === fingerprint ? current.promise : Promise.reject(new Error('Creation identity conflicts with different content'));
      const promise = (async () => {
        await start();
        const state = await serial(async () => {
          const row = journal.receipts[key];
          if (row) {
            if (row.fingerprint !== fingerprint || row.files !== files) throw new Error('Creation identity conflicts with different content');
            if (files && row.epoch !== epoch) throw new Error('Creation upload grants do not survive a bridge restart');
            return { ...row.state };
          }
          if (Object.keys(journal.receipts).length >= limit) throw new Error('Creation journal is full; existing receipts must be retained');
          await persist({ ...journal, receipts: { ...journal.receipts, [key]: { fingerprint, files, epoch, state: {} } } });
          return {} as CreationState;
        });
        const checkpoint = async (patch: CreationState) => {
          const nextState = { ...state, ...patch };
          await serial(() => persist({ ...journal, receipts: { ...journal.receipts, [key]: { ...journal.receipts[key], state: nextState } } }));
          Object.assign(state, patch);
        };
        return operation(state, checkpoint);
      })();
      pending.set(key, { fingerprint, promise });
      void promise.finally(() => { if (pending.get(key)?.promise === promise) pending.delete(key); }).catch(() => {});
      return promise;
    },
    async close() {
      closing = true;
      await Promise.allSettled([...pending.values()].map(p => p.promise));
      await started?.catch(() => {}); await tail;
      if (lockFile && lockText && await readFile(lockFile, 'utf8').catch(() => undefined) === lockText) await unlink(lockFile);
    },
  };
}
export type CreationReceipts = ReturnType<typeof createCreationReceipts>;
