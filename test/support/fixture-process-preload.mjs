// Test-only admission and teardown. Detached Node descendants inherit NODE_OPTIONS.
import { isMainThread, Worker } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import path from 'node:path';

if (isMainThread) {
  const directory = process.env.ALP_FIXTURE_PROCESSES;
  const token = process.env.ALP_FIXTURE_TOKEN;
  if (!directory || !token) throw new Error('missing fixture process admission');
  const manifest = JSON.parse(readFileSync(path.join(directory, 'owner.json'), 'utf8'));
  if (manifest.home !== process.env.ALP_HOME || manifest.token !== token) throw new Error('wrong fixture process home');
  // A separate event loop also stops a process blocked in synchronous startup work.
  const worker = new Worker(`
    const { workerData, parentPort } = require('node:worker_threads');
    const fs = require('node:fs');
    const path = require('node:path');
    const { randomUUID } = require('node:crypto');
    const { directory, home, token } = workerData;
    const stop = () => process.kill(process.pid, 'SIGKILL');
    const closed = () => {
      try {
        const owner = JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8'));
        return owner.home !== home || owner.token !== token || fs.existsSync(path.join(directory, 'closed'));
      } catch { return true; } // Admission disappearing must never run the product entry point.
    };
    if (closed()) stop();
    const file = path.join(directory, process.pid + '-' + randomUUID());
    fs.writeFileSync(file + '.tmp', JSON.stringify({ pid: process.pid, home, token }));
    fs.renameSync(file + '.tmp', file + '.json');
    if (closed()) stop();
    parentPort.postMessage('admitted');
    setInterval(() => { if (closed()) stop(); }, 10);
  `, { eval: true, execArgv: [], workerData: { directory, home: manifest.home, token } });
  await new Promise((resolve, reject) => {
    let admitted = false;
    const failed = error => {
      if (admitted) process.kill(process.pid, 'SIGKILL');
      else reject(error);
    };
    worker.once('message', () => { admitted = true; resolve(); });
    worker.once('error', failed);
    worker.once('exit', code => failed(new Error(`fixture admission exited ${code}`)));
  });
  worker.unref();
}
