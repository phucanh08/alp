import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { PROTOCOL_VERSION, MAX_FRAME, RPC_METHODS, ERROR, RPC_ERROR, CAPABILITY, encodeFrame, decodeFrame } from '@anhlp/alp-protocol';
import { CAPABILITIES, METHODS_V1, validateDefinition, validateParams, validateResult, validateSchema } from '@anhlp/alp-protocol/contract';

const here = path.dirname(fileURLToPath(import.meta.url));
const json = async file => JSON.parse(await readFile(path.join(here, '..', file), 'utf8'));
const ipc = await json('schema/ipc-v1.json');
const methods = await json('schema/methods-v1.json');
const { cases } = await json('fixtures/v1/cases.json');
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addSchema(ipc);
const ajvDefinition = name => ajv.compile({ $ref: `${ipc.$id}#/$defs/${name}` });
const source = async file => readFile(path.join(here, '../src', file), 'utf8');

test('the method inventory, errors and capabilities agree across schema, constants and types', async () => {
  assert.equal(PROTOCOL_VERSION, 1);
  assert.equal(methods.protocolVersion, PROTOCOL_VERSION);
  assert.equal(MAX_FRAME, 16 * 1024 * 1024);
  assert.deepEqual(ERROR, { failed: 1000, notFound: 1001, conflict: 1004, protocol: 1006 });
  assert.deepEqual(methods.errors, { ...RPC_ERROR, ...ERROR });
  assert.deepEqual(Object.keys(methods.methods).sort(), [...RPC_METHODS].sort());
  for (const method of RPC_METHODS) assert.ok(methods.methods[method].params && methods.methods[method].result, method);
  assert.deepEqual([...CAPABILITIES].sort(), Object.values(CAPABILITY).sort());
  const rpc = await source('rpc.ts');
  assert.deepEqual(Array.from(rpc.split('export type RpcMethodMap = {')[1].split('\n};')[0].matchAll(/^  '([^']+)': \{/gm), match => match[1]).sort(), [...RPC_METHODS].sort());
  assert.deepEqual(Array.from(rpc.match(/export type Capability = ([^;]+);/)[1].matchAll(/'([^']+)'/g), match => match[1]).sort(), [...CAPABILITIES].sort());
});

test('the two schema files share one set of definitions, and the generated contract is current', async () => {
  assert.deepEqual(methods.$defs, ipc.$defs);
  assert.deepEqual(METHODS_V1, methods);
  const generated = spawnSync(process.execPath, [path.join(here, '../scripts/generate.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
});

test('event types and item kinds in the schema are those of the TypeScript unions', async () => {
  const events = await source('events.ts');
  const eventTypes = Array.from(events.split('export type AlpEvent =')[1].split('export type Envelope')[0].matchAll(/\{ type: '([^']+)'/g), match => match[1]);
  const itemKinds = Array.from(events.split('export type TimelineItem =')[1].split('export type SessionSnapshot')[0].matchAll(/kind: '([^']+)'/g), match => match[1]);
  assert.deepEqual(ipc.$defs.knownEvent.oneOf.map(event => event.properties.type.const).sort(), [...new Set(eventTypes)].sort());
  assert.deepEqual(ipc.$defs.knownItem.oneOf.map(item => item.properties.kind.const).sort(), [...new Set(itemKinds)].sort());
  assert.deepEqual(ipc.$defs.unknownEvent.properties.type.not.enum.sort(), [...new Set(eventTypes)].sort());
  assert.deepEqual(ipc.$defs.unknownItem.properties.kind.not.enum.sort(), [...new Set(itemKinds)].sort());
});

test('golden fixtures: Ajv and the built-in checker agree with every verdict', () => {
  const message = ajv.getSchema(ipc.$id);
  const envelope = ajvDefinition('envelope');
  for (const fixture of cases) {
    let viaAjv, issues;
    if (fixture.check === 'message') { viaAjv = message(fixture.value); issues = validateSchema(ipc, fixture.value); }
    else if (fixture.check === 'envelope') { viaAjv = envelope(fixture.value); issues = validateDefinition('envelope', fixture.value); }
    else {
      const schema = { ...methods.methods[fixture.method][fixture.check], $defs: methods.$defs };
      viaAjv = ajv.compile(schema)(fixture.value);
      issues = fixture.check === 'params' ? validateParams(fixture.method, fixture.value) : validateResult(fixture.method, fixture.value);
    }
    assert.equal(viaAjv, fixture.valid, `Ajv on ${fixture.name}`);
    assert.equal(issues.length === 0, fixture.valid, `checker on ${fixture.name}: ${JSON.stringify(issues)}`);
    if (fixture.check === 'message' && !Array.isArray(fixture.value)) assert.deepEqual(decodeFrame(encodeFrame(fixture.value)), fixture.value);
  }
});

test('golden fixtures cover params and results of every method, every event type and every item kind', () => {
  for (const method of RPC_METHODS) {
    for (const check of ['params', 'result']) assert.ok(cases.some(fixture => fixture.check === check && fixture.method === method && fixture.valid), `${method} ${check}`);
  }
  const envelopes = cases.filter(fixture => fixture.check === 'envelope' && fixture.valid).map(fixture => fixture.value.event);
  for (const event of ipc.$defs.knownEvent.oneOf) assert.ok(envelopes.some(candidate => candidate.type === event.properties.type.const), event.properties.type.const);
  for (const item of ipc.$defs.knownItem.oneOf) assert.ok(envelopes.some(candidate => candidate.item?.kind === item.properties.kind.const), item.properties.kind.const);
  assert.ok(cases.filter(fixture => !fixture.valid).length >= 30, 'negative cases');
});

test('the legacy line fixtures still validate', async () => {
  const lines = (await readFile(path.join(here, '../fixtures/ipc-v1.jsonl'), 'utf8')).trim().split('\n');
  for (const line of lines) assert.deepEqual(validateSchema(ipc, decodeFrame(line)), [], line);
});

test('the checker: code point lengths, undefined as absent, null as a value, unsupported references', () => {
  const title = { type: 'string', maxLength: 2 };
  assert.deepEqual(validateSchema(title, '😀😀'), []);
  assert.equal(validateSchema(title, '😀😀😀').length, 1);
  assert.deepEqual(validateParams('session.configure', { sessionId: 's', mode: undefined }), []);
  assert.equal(validateParams('session.configure', { sessionId: 's', mode: null }).length, 1);
  assert.deepEqual(validateParams('session.list', undefined), []);
  assert.equal(validateParams('conformance.unknown', {}), undefined);
  assert.throws(() => validateSchema({ $ref: 'other.json#/x' }, 1), /Unsupported/);
  assert.throws(() => validateDefinition('nothing', {}), /No definition/);
});

test('every valid golden value type-checks against the TypeScript projection', { skip: !existsSync(path.join(here, '../../../node_modules/typescript/bin/tsc')) && 'typescript is not installed' }, async t => {
  const directory = await mkdtemp(path.join(here, '..', '.projection-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const lines = [
    "import type { Envelope, RpcParams, RpcResult } from '../src/index.js';",
    'declare function check<T>(value: T): void;',
  ];
  for (const fixture of cases) {
    if (!fixture.valid || fixture.projection === false || fixture.check === 'message') continue;
    const type = fixture.check === 'envelope' ? 'Envelope' : `${fixture.check === 'params' ? 'RpcParams' : 'RpcResult'}<'${fixture.method}'>`;
    lines.push(`// ${fixture.name}`, `check<${type}>(${JSON.stringify(fixture.value)});`);
  }
  await writeFile(path.join(directory, 'projection.ts'), `${lines.join('\n')}\n`);
  const result = spawnSync(process.execPath, [path.join(here, '../../../node_modules/typescript/bin/tsc'), '--noEmit', '--allowJs', '--strict', '--skipLibCheck', '--exactOptionalPropertyTypes', '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext', path.join(directory, 'projection.ts')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
