import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { seedLibrary } from '../src/core/library.js';
import { loadProvider } from '../src/core/providers.js';

test('fresh and upgraded libraries include OpenCode and native Antigravity without overwriting switches or commands', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'alp-default-providers-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await seedLibrary(home, { templates: { 'role-skills.json': '{}' } });
  const seeded = await seedLibrary(home);
  assert.ok(seeded.created.includes('providers/opencode.json'));
  assert.ok(seeded.created.includes('providers/antigravity.json'));
  const opencode = await loadProvider(home, 'opencode');
  assert.equal(opencode.kind, 'acp');
  assert.equal(opencode.command, 'opencode');
  assert.deepEqual(opencode.args, ['acp']);
  assert.equal(opencode.enabled, true);
  const antigravity = await loadProvider(home, 'antigravity');
  assert.equal(antigravity.kind, 'antigravity');
  assert.equal(antigravity.command, 'agy');
  assert.equal(antigravity.enabled, true);
  for (const id of ['opencode', 'antigravity']) {
    const file = path.join(home, 'providers', `${id}.json`);
    const config = { ...JSON.parse(await readFile(file, 'utf8')), enabled: false, command: `/custom/${id}` };
    await writeFile(file, JSON.stringify(config));
    await seedLibrary(home);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), config);
  }
});

test('alp providers seeds defaults without requiring project initialization', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'alp-default-provider-cli-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const rows = JSON.parse(execFileSync(process.execPath, ['src/cli.js', 'providers', '--json'], {
    env: { ...process.env, ALP_HOME: home }, encoding: 'utf8',
  }));
  assert.deepEqual(rows.map(row => row.name), ['antigravity', 'opencode']);
});
