import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { RPC_METHODS } from '@anhlp/alp-protocol';

test('the protocol method inventory matches the daemon handlers', async () => {
  const sources = await Promise.all(['server.ts', 'operations.ts'].map(file => readFile(new URL(`../src/${file}`, import.meta.url), 'utf8')));
  const methods = ['daemon.hello', ...sources.flatMap(source => Array.from(source.matchAll(/^\s*(?:async )?'([a-z]+(?:\.[a-z]+)+)'(?:\(|:)/gm), match => match[1]))].sort();
  assert.deepEqual([...RPC_METHODS].sort(), methods);
});
