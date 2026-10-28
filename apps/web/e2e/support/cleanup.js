import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Always release this fixture's service and host, even if its graceful-stop assertion fails. */
export async function closeWorldAfter(world, beforeClose) {
  try {
    await beforeClose();
  } finally {
    try {
      // Only the service recorded in this disposable world's private home. A failed assertion
      // must not leave alp-web's listener alive when the host directory is removed below.
      const info = await readFile(path.join(world.home, 'web.json'), 'utf8').then(JSON.parse, () => undefined);
      if (info?.pid && alive(info.pid)) {
        try { process.kill(info.pid, 'SIGKILL'); } catch {}
        for (let i = 0; i < 600 && alive(info.pid); i++) await delay(25);
        if (alive(info.pid)) throw new Error('Disposable alp-web did not exit during cleanup');
      }
    } finally {
      await world.close();
    }
  }
}
