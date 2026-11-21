// The owner's library forms (src/lib/owner-library.js; t-a95b group C): a hidden value read as
// alpd's keep marker goes back as the marker, never as the mask text the page shows; the review
// names what will run without any secret value.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HIDDEN } from '../src/lib/library.js';
import { KEEP, hookContent, hookForm, mcpContent, mcpForm, reviewRows } from '../src/lib/owner-library.js';

test('the mask text is the one alp dashboard\'s host.library.save refuses (packages/cli/src/dashboard/owner/library.js MASK_TEXT)', () => {
  assert.equal(HIDDEN, '‹hidden on the host›');
});

test('an MCP server round-trips through its form; an untouched hidden value stays the keep marker', () => {
  const content = { server: { command: 'node', args: ['server.js', '--x'], cwd: '/srv', env: { TOKEN: { $secret: 'keep' }, MODE: 'fast' } } };
  const form = mcpForm(content);
  assert.deepEqual(form.env, [{ key: 'TOKEN', value: null }, { key: 'MODE', value: 'fast' }]);
  assert.deepEqual(mcpContent(form), content);
  assert.deepEqual(mcpContent({ ...form, env: [{ key: 'TOKEN', value: 'new' }] }).server.env, { TOKEN: 'new' });
  assert.throws(() => mcpContent({ ...form, env: [{ key: 'TOKEN', value: HIDDEN }] }), /keep the hidden one/);
  assert.throws(() => mcpContent({ ...form, env: [{ key: 'A', value: '1' }, { key: 'A', value: '2' }] }), /twice/);
  const url = mcpForm({ server: { url: 'https://x.example/mcp', headers: { Authorization: { ...KEEP } } } });
  assert.deepEqual(mcpContent(url), { server: { url: 'https://x.example/mcp', headers: { Authorization: { $secret: 'keep' } } } });
});

test('a hook round-trips; blocking only on events that can block', () => {
  const content = { hook: { description: 'd', event: 'handoff', command: 'echo ok', blocking: true, timeoutSec: 30, match: { agent: 'main' } } };
  assert.deepEqual(hookContent(hookForm(content)), content);
  assert.throws(() => hookContent({ ...hookForm(content), event: 'turn.end' }), /can block/);
  assert.throws(() => hookContent({ ...hookForm(content), command: ' ' }), /command is required/);
});

test('the review names the command, args, env names and where; never a value', () => {
  const rows = reviewRows('mcp', 'search', 'library', { server: { command: 'node', args: ['s.js'], env: { TOKEN: { $secret: 'keep' }, NEW: 'typed-secret' } } });
  const text = rows.map(row => row.join(': ')).join('\n');
  assert.match(text, /Runs: node s\.js/);
  assert.match(text, /Env TOKEN: ‹hidden on the host› \(kept as stored\)/);
  assert.match(text, /Env NEW: •••••• \(new value\)/);
  assert.doesNotMatch(text, /typed-secret/);
  assert.match(reviewRows('hooks', 'h', 'project', { hook: { event: 'merge', command: 'make check', blocking: true } }).map(row => row.join(': ')).join('\n'), /Runs \(shell\): make check\nOn: merge\nBlocking: yes/);
});
