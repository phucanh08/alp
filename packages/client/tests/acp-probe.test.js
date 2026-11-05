import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { probeAcp } from '../src/acp-probe.js';

test('ACP probe abort closes the provider before its request timeout', async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'alp-probe-abort-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const script = path.join(cwd, 'slow.cjs');
  const ready = path.join(cwd, 'ready');
  await writeFile(script, `require('fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid)); setInterval(() => {}, 1000);`);
  const controller = new AbortController();
  const probing = probeAcp({ command: process.execPath, args: [script] }, { cwd, signal: controller.signal, timeoutMs: 10000 });
  // Attach rejection immediately; abort is deliberately triggered only after provider startup.
  const rejected = assert.rejects(probing, error => error.name === 'AbortError');
  let pid;
  for (let i = 0; i < 200; i++) { pid = Number(await readFile(ready, 'utf8').catch(() => '')); if (pid) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.ok(pid);
  const start = Date.now();
  controller.abort();
  await rejected;
  assert.ok(Date.now() - start < 3000);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  await assert.rejects(probeAcp({ command: 'never-spawn-this' }, { signal: controller.signal }), { name: 'AbortError' });
});
