// Fail the final journal rename after a real store commit, without replacing commit logic.
import { mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { SessionRecord, Store } from '@anhlp/alp-daemon';

/** How the marker is moved aside and put back; a test may hold the move. */
type MarkerOptions = {
  renameMarker?: (from: string, to: string) => Promise<void>,
  removeMarker?: (file: string, options: { recursive: boolean }) => Promise<void>,
};

export function failCommittedMarker(store: Store, state: string, requestId: string, { renameMarker = rename, removeMarker = rm }: MarkerOptions = {}) {
  const put = store.put;
  let blocked: string | undefined;
  let scanning: Promise<void> | undefined;
  const pending = new Set<Promise<void>>();
  async function install() {
    for (const name of await readdir(path.join(state, 'lifecycle')).catch(() => [])) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(state, 'lifecycle', name);
      const entry = JSON.parse(await readFile(file, 'utf8'));
      if (entry.requestId !== requestId || entry.state !== 'applied') continue;
      await renameMarker(file, `${file}.saved`);
      await mkdir(file);
      blocked = file;
      break;
    }
  }
  store.put = (record: SessionRecord) => {
    const task = (async () => {
      await put(record);
      // The store queue covers its write, not this post-write fault installation.
      // Every caller must join it before a final journal marker can be written.
      if (scanning) await scanning;
      if (blocked) return;
      const scan = scanning = install();
      await scan;
      if (scanning === scan) scanning = undefined;
    })();
    pending.add(task);
    void task.finally(() => pending.delete(task)).catch(() => {});
    return task;
  };
  return async () => {
    store.put = put;
    // Include callers still awaiting their underlying write, as well as the scanner.
    const results = await Promise.allSettled([...pending]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    if (!blocked) throw new Error('fault did not intercept a post-applied store commit');
    await removeMarker(blocked, { recursive: true });
    await renameMarker(`${blocked}.saved`, blocked);
    return JSON.parse(await readFile(blocked, 'utf8'));
  };
}
