// Fail the final journal rename after a real store commit, without replacing commit logic.
import { mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
export function failCommittedMarker(store, state, requestId) {
  const put = store.put;
  let blocked;
  let scanning = false;
  store.put = async record => {
    await put(record);
    if (blocked || scanning) return;
    scanning = true;
    for (const name of await readdir(path.join(state, 'lifecycle')).catch(() => [])) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(state, 'lifecycle', name);
      const entry = JSON.parse(await readFile(file, 'utf8'));
      if (entry.requestId !== requestId || entry.state !== 'applied') continue;
      blocked = file;
      await rename(file, `${file}.saved`);
      await mkdir(file);
      break;
    }
    scanning = false;
  };
  return async () => {
    store.put = put;
    if (!blocked) throw new Error('fault did not intercept a post-applied store commit');
    await rm(blocked, { recursive: true });
    await rename(`${blocked}.saved`, blocked);
    return JSON.parse(await readFile(blocked, 'utf8'));
  };
}
