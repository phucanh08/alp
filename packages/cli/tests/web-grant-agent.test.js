import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGrant } from '../src/web/grant.js';

test('alp web refuses to hand out its user credential to a process an ALP agent started (t-1c59)', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'alp-web-grant-'));
  const saved = process.env.ALP_AGENT_SESSION;
  process.env.ALP_AGENT_SESSION = 'session-1';
  t.after(async () => { if (saved === undefined) delete process.env.ALP_AGENT_SESSION; else process.env.ALP_AGENT_SESSION = saved; await rm(home, { recursive: true, force: true }); });
  let touched = false;
  const store = { reload: async () => { touched = true; }, verify: () => { touched = true; return undefined; } };
  const grant = createGrant({ home, store, permissions: [], socket: () => undefined });
  await assert.rejects(grant.ensure({}), /started by an ALP agent/);
  assert.equal(touched, false);
  assert.deepEqual(await readdir(home), [], 'no credentials directory or file was written');
});

test('every alp web command refuses a process an ALP agent started, printing no token (t-1c59)', async t => {
  const { spawnSync } = await import('node:child_process');
  const { writeFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const home = await mkdtemp(path.join(os.tmpdir(), 'alp-web-cli-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  // A running service's record, as alp web would print it.
  await writeFile(path.join(home, 'web.json'), JSON.stringify({ url: 'http://127.0.0.1:1', token: 'alpgw1.secret-token' }), { mode: 0o600 });
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  for (const args of [['web', '--print'], ['web', 'rotate'], ['web', 'pair']]) {
    const run = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, ALP_HOME: home, ALP_AGENT_SESSION: 'session-1' }, timeout: 30_000 });
    assert.notEqual(run.status, 0, args.join(' '));
    assert.match(run.stderr, /started by an ALP agent/, args.join(' '));
    assert.doesNotMatch(`${run.stdout}${run.stderr}`, /secret-token/, args.join(' '));
  }
});
