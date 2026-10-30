import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { claudeToolShapes, inputLimitError, POUR_VARS, TOOL_INPUT } from '@anhlp/alp-runtime';
import { MCP_TOOLS, openMcpTools } from '@anhlp/alp-runtime/mcp-tools';

const fakeMcp = new URL('../../../test/support/fake-mcp.js', import.meta.url).pathname;
const limits = { bytes: 100, items: 5, depth: 2, string: 10 };

test('inputLimitError stops at the first cap a value passes: text, values, nesting, bytes', () => {
  assert.equal(inputLimitError({ a: ['x', 1, true, null] }, limits), undefined);
  assert.match(inputLimitError(['x'.repeat(11)], limits), /is too large: a text over 10 characters/);
  assert.match(inputLimitError({ ['k'.repeat(11)]: 1 }, limits, 'vars'), /^vars is too large: a text over 10/);
  assert.match(inputLimitError([1, 2, 3, 4, 5, 6], limits), /is too large: over 5 values/);
  // Values are counted over the whole input, not per container.
  assert.equal(inputLimitError({ a: [1, 2], b: [3] }, limits), undefined);
  assert.match(inputLimitError({ a: [1, 2, 3], b: [4] }, limits), /is too large: over 5 values/);
  assert.match(inputLimitError([[[]]], limits), /is too large: nested over 2 levels deep/);
  // Bytes are UTF-8: five texts of ten ASCII letters fit, of ten é do not.
  assert.equal(inputLimitError(Array(5).fill('e'.repeat(10)), { ...limits, items: 10 }), undefined);
  assert.match(inputLimitError(Array(5).fill('é'.repeat(10)), { ...limits, items: 10 }), /is too large: over 100 bytes/);
  assert.equal(inputLimitError('plain', limits), undefined);
  assert.equal(inputLimitError(undefined, limits), undefined);
  // An oversized list is refused before any element is read.
  let read = 0;
  const list = Array.from({ length: 6 }, () => 'x');
  Object.defineProperty(list, 0, { get: () => { read++; return 'x'; } });
  assert.match(inputLimitError(list, limits), /over 5 values/);
  assert.equal(read, 0);
  assert.ok(TOOL_INPUT.string >= 32_000, 'alp_delegate takes a 32,000-character task');
});

test('Claude tool shapes refuse oversized paths, kinds and vars before zod walks them, and advertise the bounds', () => {
  const pin = z.object(claudeToolShapes.alp_pin);
  let read = 0;
  const paths = Array.from({ length: 51 }, (_, i) => `src/${i}`);
  Object.defineProperty(paths, 0, { get: () => { read++; return 'src/0'; } });
  const refused = pin.safeParse({ kind: 'claim', body: 'x', paths });
  assert.equal(refused.success, false);
  assert.match(refused.error.issues[0].message, /over 50 values/);
  assert.equal(read, 0, 'zod never walked the elements');
  assert.match(pin.safeParse({ kind: 'claim', body: 'x', paths: ['a'.repeat(1025)] }).error.issues[0].message, /a text over 1024 characters/);
  assert.deepEqual(pin.parse({ kind: 'claim', body: 'x', paths: ['src'] }), { kind: 'claim', body: 'x', paths: ['src'] });
  assert.equal(pin.safeParse({ kind: 'decision', body: 'x'.repeat(2001) }).success, false);

  const board = z.object(claudeToolShapes.alp_board);
  assert.match(board.safeParse({ kinds: ['claim', 'claim', 'decision', 'finding'] }).error.issues[0].message, /over 3 values/);
  assert.deepEqual(board.parse({ kinds: ['claim'] }), { kinds: ['claim'] });
  assert.deepEqual(board.parse({}), {});

  const task = z.object(claudeToolShapes.alp_task);
  const many = Object.fromEntries(Array.from({ length: POUR_VARS.items + 1 }, (_, i) => [`v${i}`, 'x']));
  assert.match(task.safeParse({ action: 'pour', formula: 'release', vars: many }).error.issues[0].message, /over 50 values/);
  assert.match(task.safeParse({ action: 'pour', formula: 'release', vars: { version: 'x'.repeat(2001) } }).error.issues[0].message, /a text over 2000 characters/);
  assert.equal(task.safeParse({ action: 'pour', formula: 'release', vars: { 'not a name': '1' } }).success, false);
  assert.deepEqual(task.parse({ action: 'pour', formula: 'release', vars: { version: '1.0' } }).vars, { version: '1.0' });

  // The guard leaves the JSON Schema Claude sees to the inner schema, bounds included.
  const schema = z.toJSONSchema(z.object({ ...claudeToolShapes.alp_pin, ...claudeToolShapes.alp_board }), { io: 'input' });
  assert.deepEqual(schema.properties.paths, { maxItems: 50, type: 'array', items: { type: 'string', minLength: 1, maxLength: 1024 } });
  assert.deepEqual(schema.properties.kinds, { maxItems: 3, type: 'array', items: { type: 'string', enum: ['claim', 'decision', 'finding'] } });
  assert.deepEqual(schema.required, ['kind', 'body']);
});

test('external MCP tools/list is bounded: pages, tools, and the size of a page before the SDK parses it', async () => {
  const open = env => openMcpTools({ docs: { command: process.execPath, args: [fakeMcp], env } }, process.cwd(), process.env);
  const listed = await open({});
  assert.deepEqual(listed.tools.map(tool => tool.description), ['[MCP docs: search] Search the docs', '[MCP docs: fetch] ']);
  await listed.close();
  const cause = async env => {
    const error = await open(env).then(() => assert.fail('listed'), error => error);
    assert.match(error.message, /External MCP server 'docs' could not initialize or list tools/);
    return error.cause.message;
  };
  assert.match(await cause({ FAKE_MCP_ENDLESS: '1' }), new RegExp(`More than ${MCP_TOOLS.pages} pages of MCP tools`));
  assert.match(await cause({ FAKE_MCP_TOOLS: String(MCP_TOOLS.tools + 1) }), new RegExp(`More than ${MCP_TOOLS.tools} MCP tools`));
  assert.match(await cause({ FAKE_MCP_DESCRIPTION: String(64 * 1024 + 1) }), /A tools\/list page is too large: a text over 65536 characters/);
  const big = await open({ FAKE_MCP_DESCRIPTION: String(64 * 1024) });
  assert.equal(big.tools[0].description.length, '[MCP docs: big] '.length + 64 * 1024);
  await big.close();
});
