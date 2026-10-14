import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv';
import { PROTOCOL_VERSION, MAX_FRAME, RPC_METHODS, ERROR, encodeFrame, decodeFrame } from '@anhlp/alp-protocol';

const schema = JSON.parse(await readFile(new URL('../schema/ipc-v1.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: false });
ajv.addSchema(schema);
const validateEnvelope = ajv.compile({ $ref: `${schema.$id}#/$defs/envelope` });

test('v1 fixtures, schema, method and event inventories agree', async () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(MAX_FRAME, 16 * 1024 * 1024);
  assert.deepEqual(ERROR, { failed: 1000, notFound: 1001, conflict: 1004, protocol: 1006 });
  const validate = ajv.getSchema(schema.$id);
  const notification = ajv.compile({ $ref: `${schema.$id}#/$defs/notification` });
  const lines = (await readFile(new URL('../fixtures/ipc-v1.jsonl', import.meta.url), 'utf8')).trim().split('\n');
  for (const line of lines) {
    const frame = decodeFrame(line);
    assert.deepEqual(decodeFrame(encodeFrame(frame)), frame);
    assert.ok(validate(frame), JSON.stringify(validate.errors));
    if (frame.method === 'event') assert.ok(notification(frame), JSON.stringify(notification.errors));
  }
  const methodSchema = JSON.parse(await readFile(new URL('../schema/methods-v1.json', import.meta.url), 'utf8'));
  const methods = [...RPC_METHODS].sort();
  assert.deepEqual(Object.keys(methodSchema.methods).sort(), methods);
  for (const method of methods) ajv.compile({ ...methodSchema.methods[method].params, $defs: methodSchema.$defs });
  const eventTypes = Array.from((await readFile(new URL('../src/events.ts', import.meta.url), 'utf8')).split('export type AlpEvent =')[1].matchAll(/\{ type: '([^']+)'/g), match => match[1]);
  assert.deepEqual(schema.$defs.event.oneOf.map(event => event.properties.type.const).sort(), eventTypes.sort());
  assert.equal(validateEnvelope({ sessionId: 'a', epoch: 'e', seq: -1, ts: 't', event: { type: 'session.ready' } }), false);
  assert.equal(validateEnvelope({ sessionId: 'a', epoch: 'e', seq: 0, ts: 't', event: { type: 'item' } }), false);
});
