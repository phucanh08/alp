import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listProviders } from '../src/providers.js';

test('listProviders: with onError an invalid file is reported and skipped; without it the list fails', async t => {
  const library = await mkdtemp(path.join(tmpdir(), 'alp-providers-'));
  t.after(() => rm(library, { recursive: true, force: true }));
  await mkdir(path.join(library, 'providers'));
  await writeFile(path.join(library, 'providers', 'bad.json'), '{ not json');
  await writeFile(path.join(library, 'providers', 'good.json'), JSON.stringify({ kind: 'acp', command: 'good-agent' }));
  await assert.rejects(listProviders(library));
  const errors = [];
  const providers = await listProviders(library, { onError: (error, name) => errors.push(name) });
  assert.deepEqual(providers.map(provider => provider.id), ['good']);
  assert.deepEqual(errors, ['bad.json']);
});

test('legacy readOnlyMode loads with migration guidance but cannot be newly configured', async t => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const { loadProvider, validateProvider, PROVIDER_SETTINGS } = await import('../src/providers.js');
  const home = await mkdtemp(path.join(tmpdir(), 'alp-provider-migration-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, 'providers'));
  const file = path.join(home, 'providers/antigravity.json');
  const old = JSON.stringify({ kind: 'antigravity', command: 'agy', readOnlyMode: 'reject' });
  await writeFile(file, old);
  const warnings = [];
  const warn = console.warn;
  console.warn = message => warnings.push(message);
  try {
    assert.equal(Object.hasOwn(await loadProvider(home, 'antigravity'), 'readOnlyMode'), false);
    await loadProvider(home, 'antigravity');
  } finally { console.warn = warn; }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /select a session mode.*Existing sessions keep their mode/);
  assert.equal(await readFile(file, 'utf8'), old);
  assert.equal(PROVIDER_SETTINGS.includes('readOnlyMode'), false);
  assert.throws(() => validateProvider(JSON.parse(old), 'test', 'antigravity'), /readOnlyMode was removed/);
});
