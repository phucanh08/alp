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
