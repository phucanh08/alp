// The Paseo integration entry (server/main.ts) owns the `web` integration lock from
// @anhlp/alp-client/integration-lock; the lock's own protocol tests live in packages/client/tests.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const outer = await mkdtemp(path.join(tmpdir(), 'alp-integration-lock-'));
process.env.ALP_HOME = path.join(outer, 'outer-home');
await mkdir(process.env.ALP_HOME, { mode: 0o700 });
after(() => rm(outer, { recursive: true, force: true }));
async function fixture() {
  const home = await mkdtemp(path.join(outer, 'home-'));
  const file = path.join(home, 'integrations/web.lock');
  await mkdir(path.dirname(file), { mode: 0o700 });
  return { home, file, guard: file + '.reclaim' };
}

test('a real integration whose release fails at shutdown still exits once, retaining its lock and logging recovery', async t => {
  const f = await fixture();
  await writeFile(path.join(f.home, 'settings.json'), JSON.stringify({ web: { port: 40_000 + Math.floor(Math.random() * 20_000), relay: { enabled: false } } }));
  const main = new URL('../server/dist/main.js', import.meta.url);
  const preload = new URL('./support/integration-main-preload.mjs', import.meta.url).href;
  const child = fork(main, ['--service'], { execArgv: ['--import', preload], env: { ...process.env, ALP_HOME: f.home, ALP_LOCK_FIXTURE: path.dirname(f.home), ALP_SUPERVISE: '0' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const gone = once(child, 'exit'); child.kill('SIGKILL'); await gone; } });
  const exited = once(child, 'exit');
  const seen = [], waiting = [];
  child.on('message', message => { seen.push(message); for (const w of waiting.splice(0)) w(); });
  async function message(event) {
    const timer = { id: undefined };
    try {
      for (;;) {
        const found = seen.find(m => m.event === event); if (found) return found;
        await Promise.race([new Promise(resolve => waiting.push(resolve)), exited,
          new Promise((_, reject) => { timer.id = setTimeout(() => reject(new Error(`no ${event}; saw ${JSON.stringify(seen)}`)), 20_000); })]);
        clearTimeout(timer.id);
        if (child.exitCode !== null && !seen.some(m => m.event === event)) throw new Error(`exited before ${event}`);
      }
    } finally { clearTimeout(timer.id); }
  }
  await message('handlers');
  const owned = JSON.parse(await readFile(f.file, 'utf8')); assert.equal(owned.pid, child.pid);
  child.kill('SIGTERM'); await message('gate');
  // A second signal and an uncaught exception arrive while release is still in flight.
  child.kill('SIGTERM'); await new Promise(resolve => { const check = () => seen.some(m => m.event === 'signal' && m.signals === 2) ? resolve() : waiting.push(check); check(); });
  child.send({ command: 'throw' }); await message('thrown');
  child.send({ command: 'resume' });
  let bound;
  const outcome = await Promise.race([exited.then(([code, signal]) => ({ code, signal })),
    new Promise(resolve => { bound = setTimeout(() => resolve({ stuck: true }), 10_000); })]);
  clearTimeout(bound);
  const attempts = Math.max(0, ...seen.filter(m => m.event === 'release-attempt').map(m => m.attempts));
  const records = (await readFile(path.join(f.home, 'logs/integrations/paseo.log'), 'utf8')).split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return { line }; } });
  const codes = records.map(r => r.code).filter(Boolean);
  const counts = JSON.stringify(Object.fromEntries([...new Set(codes)].map(c => [c, codes.filter(x => x === c).length])));
  assert.deepEqual({ outcome, attempts }, { outcome: { code: 0, signal: null }, attempts: 1 }, `log codes: ${counts}`);
  assert.equal(codes.filter(c => c === 'ALP_LOCK_RELEASE_FAILED').length, 1, counts);
  // Exactly the one injected uncaught exception is logged; no other warnings and no shutdown loop.
  assert.equal(counts, JSON.stringify({ ALP_FATAL: 1, ALP_LOCK_RELEASE_FAILED: 1 }));
  assert.match(records.find(r => r.code === 'ALP_LOCK_RELEASE_FAILED').error.message, /injected release guard failure/);
  // Fail closed: the failed release leaves the owner's lock in place and creates no guard.
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), owned);
  await assert.rejects(stat(f.guard), { code: 'ENOENT' });
});
