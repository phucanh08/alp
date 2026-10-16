import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import Ajv from 'ajv';
import { createAlpRuntime } from '@anhlp/alp-runtime';

// The wire schema ships with the protocol package this runtime depends on.
const schema = JSON.parse(await readFile(new URL('../schema/ipc-v1.json', import.meta.resolve('@anhlp/alp-protocol')), 'utf8'));
const ajv = new Ajv({ strict: false });
ajv.addSchema(schema);
const validateEnvelope = ajv.compile({ $ref: `${schema.$id}#/$defs/envelope` });

test('runtime emits schema-compatible v1 events through the existing provider injection seam', async t => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'alp-contract-'));
  const emitted = [];
  const runtime = createAlpRuntime({ transport: () => ({
    initialize: async () => {}, onNotification() {}, onFailure() {}, onRequest() {}, close: async () => {},
    request: async method => method.startsWith('thread/') ? { thread: { id: 'native' } } : {},
  }) });
  t.after(() => runtime.shutdown());
  // After hooks run in the order they are added: remove the files only once that has stopped.
  t.after(() => rm(cwd, { recursive: true, force: true }));
  runtime.onEvent(envelope => emitted.push(envelope));
  await runtime.open('contract', { cwd, persist: true, mode: 'read-only' });
  await runtime.close('contract');
  assert.ok(emitted.length >= 3);
  for (const envelope of emitted) assert.ok(validateEnvelope(envelope), JSON.stringify(validateEnvelope.errors));
});
