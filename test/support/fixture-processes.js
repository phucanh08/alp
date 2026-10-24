import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const preload = new URL('./fixture-process-preload.mjs', import.meta.url).href;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };

/** Only fixture-admitted processes can stop themselves; metadata never authorizes a signal. */
export async function fixtureProcesses(home) {
  const directory = path.join(home, 'fixture-processes');
  const token = randomUUID();
  await mkdir(directory, { mode: 0o700 });
  await writeFile(path.join(directory, 'owner.json'), JSON.stringify({ home, token }), { mode: 0o600 });
  const env = {
    ALP_HOME: home,
    ALP_SERVICE_DIR: path.join(home, 'fixture-services'),
    ALP_FIXTURE_PROCESSES: directory,
    ALP_FIXTURE_TOKEN: token,
    NODE_OPTIONS: `--import=${preload}`,
  };
  const processes = async () => {
    const files = (await readdir(directory)).filter(file => file !== 'owner.json' && file.endsWith('.json'));
    const entries = await Promise.all(files.map(async file => JSON.parse(await readFile(path.join(directory, file), 'utf8'))));
    for (const entry of entries) assert.ok(entry.home === home && entry.token === token && Number.isSafeInteger(entry.pid) && entry.pid > 1 && entry.pid !== process.pid, 'invalid fixture registration');
    return entries;
  };
  const running = async () => (await processes()).filter(entry => alive(entry.pid));
  let stopping;
  const stop = () => stopping ??= (async () => {
    await writeFile(path.join(directory, 'closed'), token, { mode: 0o600 });
    // Workers register before entry. Late admissions see CLOSED (or a missing owner)
    // and exit before any product code can spawn another daemon or publish metadata.
    let quiet = 0;
    for (let i = 0; i < 400; i++) {
      quiet = (await running()).length ? 0 : quiet + 1;
      if (quiet === 3) return;
      await sleep(25);
    }
    throw new Error(`fixture processes did not exit: ${(await running()).map(entry => entry.pid).join(', ')}`);
  })();
  return { env, processes, running, stop };
}
