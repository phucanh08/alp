import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { RPC_METHODS } from '@anhlp/alp-protocol';

test('the protocol method inventory matches the daemon handlers', async () => {
  const server = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  const methods = ['daemon.hello', ...Array.from(server.matchAll(/^\s*(?:async )?'([a-z]+\.[a-z]+)'(?:\(|:)/gm), match => match[1])].sort();
  assert.deepEqual([...RPC_METHODS].sort(), methods);
});
