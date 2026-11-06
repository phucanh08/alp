// GHSA-mrhx-c7xc-m3w5 (t-d676): zod before 4.6.6 parsed every element of an array, map or set
// before checking its .max(), and kept one issue per failing element, so an oversized collection
// cost memory in proportion to its length. From 4.6.6 a collection over its cap fails that cap
// before any element is read. These tests pin that behaviour for the zod ALP installs and for
// ALP's own tool schemas (claude-transport.ts toolShapes), the place where model-produced tool
// input reaches ALP's zod.
//
// Scope: this covers the zod ALP declares. The Claude Agent SDK ships its own bundled zod copies,
// which these tests do not reach; that residual is tracked as t-ffe4.3 (docs/alp/zod-advisory.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { claudeToolShapes } from '@anhlp/alp-runtime';

const zodVersion = createRequire(import.meta.url)('zod/package.json').version;

/** `length` elements that each fail their schema, counting how many zod reads. */
function oversized(length, element = 1) {
  const counter = { read: 0 };
  const list = new Array(length);
  for (let i = 0; i < length; i++) {
    Object.defineProperty(list, i, { enumerable: true, get: () => { counter.read++; return element; } });
  }
  return { list, counter };
}

test(`the installed zod (${zodVersion}) is at or above the GHSA-mrhx-c7xc-m3w5 fix, 4.6.6`, () => {
  const [major, minor, patch] = zodVersion.split(/[.-]/).map(Number);
  assert.ok(major > 4 || (major === 4 && (minor > 6 || (minor === 6 && patch >= 6))), `zod ${zodVersion} is in the affected range <4.6.6`);
});

test('an oversized constrained array, set or map fails its cap without zod reading an element', () => {
  const { list, counter } = oversized(10_000);
  const array = z.array(z.string()).max(10).safeParse(list);
  assert.equal(array.success, false);
  assert.equal(counter.read, 0, 'zod read elements of an array already over its cap');
  assert.deepEqual(array.error.issues.map(issue => issue.code), ['too_big']);

  const set = z.set(z.string()).max(10).safeParse(new Set(Array.from({ length: 10_000 }, (_, i) => i)));
  assert.deepEqual(set.error.issues.map(issue => issue.code), ['too_big']);

  const map = z.map(z.string(), z.string()).max(10).safeParse(new Map(Array.from({ length: 10_000 }, (_, i) => [i, i])));
  assert.deepEqual(map.error.issues.map(issue => issue.code), ['too_big']);

  // Within the cap, elements are still validated one by one.
  assert.equal(z.array(z.string()).max(10).safeParse(['a', 1]).error.issues[0].path[0], 1);
});

test('every capped array in ALP\'s Claude tool shapes refuses an oversized list before reading it', () => {
  const checked = [];
  for (const [tool, shape] of Object.entries(claudeToolShapes)) {
    const schema = z.object(shape);
    const properties = z.toJSONSchema(schema, { io: 'input' }).properties ?? {};
    for (const [field, json] of Object.entries(properties)) {
      if (json.type !== 'array' || typeof json.maxItems !== 'number') continue;
      const { list, counter } = oversized(json.maxItems + 1_000);
      const result = schema.safeParse({ [field]: list });
      assert.equal(result.success, false, `${tool}.${field}`);
      assert.equal(counter.read, 0, `${tool}.${field}: zod read elements of a list over its ${json.maxItems}-item cap`);
      const issues = result.error.issues.filter(issue => issue.path[0] === field);
      assert.equal(issues.length, 1, `${tool}.${field}: ${issues.length} issues for one oversized list`);
      checked.push(`${tool}.${field}`);
    }
  }
  // The walk must find the shapes it is meant to guard; a rename must not empty it silently.
  for (const field of ['alp_handoff.candidate', 'alp_handoff.discovered', 'alp_wait.assignments', 'alp_pin.paths']) {
    assert.ok(checked.includes(field), `${field} was not checked (checked: ${checked.join(', ')})`);
  }
});

test('the nested reviewer verdict lists refuse an oversized list before reading it', () => {
  const handoff = z.object(claudeToolShapes.alp_handoff);
  for (const [field, cap] of [['criteria', 50], ['findings', 100]]) {
    const { list, counter } = oversized(cap + 1_000, {});
    const verdict = { result: 'pass', criteria: [{ criterion: 'c', result: 'pass', evidence: 'e' }], [field]: list };
    const result = handoff.safeParse({ outcome: 'complete', summary: 's', verdict });
    assert.equal(result.success, false, field);
    assert.equal(counter.read, 0, `verdict.${field}: zod read elements of a list over its ${cap}-item cap`);
    assert.deepEqual(result.error.issues.map(issue => [issue.code, issue.path.join('.')]), [['too_big', `verdict.${field}`]]);
  }
});
