// session.commands through the gateway (t-f628, docs/protocol/alp-json-rpc-v1.md §12.12): session.read on
// a session in the grant; only the known fields of each entry pass, bounded, so no path or other field
// alpd might answer reaches a client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EXPOSURE, FORWARDED_CAPABILITIES } from '../src/policy.js';
import { fakeDaemon, summary } from './support/fake-daemon.js';
import { startGateway } from './support/harness.js';

async function world(t, { capabilities = ['attach.after', 'prompt.receipts', 'session.commands'] } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-gw-commands-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const [a, b] = ['a', 'b'].map(name => path.join(directory, name));
  for (const dir of [a, b]) await mkdir(dir, { recursive: true });
  const [ca, cb] = await Promise.all([a, b].map(dir => realpath(dir)));
  const daemon = fakeDaemon({ capabilities, sessions: [summary('sa', ca), summary('sb', cb)] });
  daemon.state.handlers['session.commands'] = () => daemon.state.answer;
  const gw = await startGateway(t, { daemon, credentials: {
    reader: { workspaces: [a], permissions: ['session.read'] },
    none: { workspaces: [a], permissions: ['project.read'] },
  } });
  return { daemon, ...gw };
}

test('the matrix: session.commands is session.read, forwarded only when alpd lists it', async t => {
  assert.equal(EXPOSURE['session.commands'].permission, 'session.read');
  assert.deepEqual(EXPOSURE['session.commands'].params, ['sessionId']);
  assert.ok(FORWARDED_CAPABILITIES.includes('session.commands'));
  assert.ok((await (await world(t)).sdk('reader')).hello.capabilities.includes('session.commands'));
  assert.ok(!(await (await world(t, { capabilities: ['attach.after'] })).sdk('reader')).hello.capabilities.includes('session.commands'));
});

test('the answer keeps only name, description, argumentHint and kind, bounded; out of scope or without session.read alpd is not asked', async t => {
  const { daemon, sdk } = await world(t);
  daemon.state.answer = { commands: [
    { name: 'compact', description: 'Clear', argumentHint: '<what>', kind: 'command', path: '/home/u/.claude/commands/compact.md' },
    { name: 'alp:xia', description: 'x'.repeat(5000), kind: 'skill', env: { TOKEN: 'secret' } },
    { name: 'two words', description: 'dropped', kind: 'command' },
    { name: 'odd', description: 7, argumentHint: 9, kind: 'agent' },
    ...Array.from({ length: 1100 }, (_, index) => ({ name: `c${index}`, description: '', kind: 'command' })),
  ], secret: '/etc/passwd' };
  const { client } = await sdk('reader');
  const { commands, ...rest } = await client.request('session.commands', { sessionId: 'sa' });
  assert.deepEqual(rest, {});
  assert.equal(commands.length, 1000);
  assert.deepEqual(commands[0], { name: 'compact', description: 'Clear', argumentHint: '<what>', kind: 'command' });
  assert.deepEqual(commands[1], { name: 'alp:xia', description: 'x'.repeat(4096), kind: 'skill' });
  assert.deepEqual(commands[2], { name: 'odd', description: '', kind: 'command' });
  assert.ok(!JSON.stringify(commands).includes('secret') && !JSON.stringify(commands).includes('/home/u'));
  const mark = daemon.calls().length;
  await assert.rejects(client.request('session.commands', { sessionId: 'sb' }), error => error.code === 1001);
  await assert.rejects((await sdk('none')).client.request('session.commands', { sessionId: 'sa' }), error => error.code === 1003);
  assert.equal(daemon.calls().slice(mark).filter(call => call.method === 'session.commands').length, 0);
});
