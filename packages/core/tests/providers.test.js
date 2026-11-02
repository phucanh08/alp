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
