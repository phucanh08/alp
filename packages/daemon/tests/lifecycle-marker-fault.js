// Fail the final journal rename after a real store commit, without replacing commit logic.
import { mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
export function failCommittedMarker(store, state, requestId, { renameMarker = rename, removeMarker = rm } = {}) {
  const put = store.put;
  let blocked;
  let scanning;
  const pending = new Set();
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
  store.put = record => {
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
