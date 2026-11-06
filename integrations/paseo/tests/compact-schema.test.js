// t-5294.4: what keeps alp.agent.compact's input inside its limits, and the one zod shape that can.
//
// zod's fix for GHSA-mrhx-c7xc-m3w5 (4.6.6; ALP ships 4.6.7 since t-d676) refuses a collection that
// is over its `.max()` BEFORE reading a single element — for `array`, `map` and `set`, and for
// nothing else. `z.record` is NOT covered: a capped record is still walked element by element, with
// one issue kept per failure. agentCompact.sessions (max 4) depends on being an array, and had no
// test of its own at the ALP level: packages/runtime/tests/zod-security.test.js walks only
// claude-transport.ts's claudeToolShapes, so turning this field into a record — the natural shape
// for "session ids by provider" — would have passed every test in the repository.
//
// Lanes: ci.yml `paseo` (node 22 and 24) and `core-paseo-macos`, which build the plugin first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

/**
 * The contract the plugin really registers, from the build when there is one. A worktree with no
 * build (and no way to make one) falls back to the schema source, which needs Node's type stripping
 * (>= 22.18, above this repository's >= 22.12 floor) — hence a fallback and not the only route.
 * Neither available is a skip naming the reason, never a crashed file.
 */
const schema = await (async () => {
  try {
    const { registerCompactRpc } = await import('@anhlp/alp-paseo/panel/compact');
    const contracts = new Map();
    registerCompactRpc({ connect: async () => { throw new Error('the schema is read, never called'); } })({ handle: contract => contracts.set(contract.name, contract) });
    const contract = contracts.get('alp.agent.compact');
    if (contract?.input) return { input: contract.input, from: 'the built plugin' };
    throw new Error('the built plugin registered no alp.agent.compact input');
  } catch (fromBuild) {
    try { return { input: (await import('../shared/compact.ts')).agentCompact.input, from: 'the schema source' }; }
    catch (fromSource) { return { skip: `alp.agent.compact is unreadable: ${fromBuild.message} / ${fromSource.message}` }; }
  }
})();
const when = { skip: schema.skip ?? false };

/** `length` elements that each count how often zod reads them (packages/runtime/tests/zod-security.test.js). */
function oversized(length, element = 'x') {
  const counter = { read: 0 };
  const list = new Array(length);
  for (let i = 0; i < length; i++) Object.defineProperty(list, i, { enumerable: true, get: () => { counter.read++; return element; } });
  return { list, counter };
}

test(`alp.agent.compact sessions is a capped array, the shape zod refuses before reading it (t-5294.4, from ${schema.from ?? 'nowhere'})`, when, () => {
  const sessions = z.toJSONSchema(schema.input, { io: 'input' }).properties?.sessions;
  // A record or a plain object here would be outside zod's fix, whatever cap it declared.
  assert.equal(sessions?.type, 'array', `sessions must stay an array: ${JSON.stringify(sessions)}`);
  assert.equal(sessions.maxItems, 4);
  assert.equal(sessions.minItems, 1);
  assert.equal(sessions.items?.maxLength, 128);
});

test('an oversized alp.agent.compact sessions list is refused without reading an element (t-5294.4)', when, () => {
  const { list, counter } = oversized(10_000);
  const result = schema.input.safeParse({ sessions: list });
  assert.equal(result.success, false, 'an oversized sessions list must be refused');
  assert.equal(counter.read, 0, `zod read ${counter.read} elements of a list already over its 4-item cap`);
  assert.deepEqual(result.error.issues.map(issue => [issue.code, issue.path.join('.')]), [['too_big', 'sessions']]);
});

test('alp.agent.compact still validates each session id it does read (t-5294.4)', when, () => {
  assert.deepEqual(schema.input.parse({ sessions: ['a', 'b', 'c', 'd'] }), { sessions: ['a', 'b', 'c', 'd'] });
  for (const [input, why] of [
    [{ sessions: [] }, 'at least one id'],
    [{ sessions: ['x'.repeat(129)] }, 'an id longer than 128 characters'],
    [{ sessions: [''] }, 'an empty id'],
    [{ sessions: ['a', 'b', 'c', 'd', 'e'] }, 'a fifth id'],
    [{ sessions: { first: 'a' } }, 'a record instead of a list'],
    [{}, 'no sessions at all'],
  ]) assert.equal(schema.input.safeParse(input).success, false, why);
  // Within the cap, a bad element is still reported by its index.
  assert.deepEqual(schema.input.safeParse({ sessions: ['ok', ''] }).error.issues[0].path, ['sessions', 1]);
});
