import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { initProject } from '@anhlp/alp-core/init';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { fakeTransport, until } from '../../../test/support/fake-agent.js';

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-schedule-tool-'));
  await initProject(root);
  await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify({ delegation: { main: ['peer'] } }));
  const agents = [], calls = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(agents), supervisor: false, userAskTimeoutMs: 1000 });
  runtime.bindSchedules(async (action, params) => { calls.push({ action, params }); return action === 'list' ? { jobs: [] } : { job: { id: 'sch_1234567890abcdef', ...params } }; });
  t.after(async () => { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); });
  await runtime.open('root', { cwd: root });
  await runtime.prompt('root', { clientMessageId: 'first', delivery: 'auto', content: [{ type: 'text', text: 'Work' }] });
  return { root, agents, calls, runtime, main: agents[0] };
}
const draft = () => ({ action: 'create', dueAt: new Date(Date.now() + 60000).toISOString(), prompt: 'Resume work after checking actual quota.', requestId: 'proposal-1' });

test('main proposes a schedule with exact time/session/prompt; creation needs approval and identical replay is deduplicated', async t => {
  const { runtime, main, calls, root } = await setup(t);
  assert.ok(main.config.dynamicTools.some(tool => tool.name === 'alp_schedule'));
  const args = draft();
  const pending = await main.call('alp_schedule', args);
  assert.equal(pending.status, 'pending_approval');
  assert.deepEqual(calls, []);
  const question = runtime.questions().find(question => question.id === pending.approvalId);
  assert.ok(question);
  assert.ok(question.body.includes(args.dueAt) && question.body.includes(args.prompt) && question.body.includes('root'));
  assert.equal((await main.call('alp_schedule', args)).approvalId, pending.approvalId);
  assert.match((await main.call('alp_schedule', { ...args, prompt: 'Changed draft' })).error, /another schedule draft/);
  main.finish('Awaiting the user decision.');
  await until(() => !runtime.snapshot('root').activeTurnId);
  assert.ok(runtime.questions().some(question => question.id === pending.approvalId), 'approval survives turn end');
  runtime.answer(pending.approvalId, { text: 'approve' });
  await until(() => calls.length === 1);
  assert.deepEqual(calls[0], { action: 'create', params: { projectRoot: root, sessionId: 'root', dueAt: args.dueAt, prompt: args.prompt } });
  await until(async () => (await main.call('alp_schedule', args)).status === 'resolved');
  assert.equal(calls.length, 1);
  assert.deepEqual(await main.call('alp_schedule', { action: 'list' }), { jobs: [] });
  assert.equal(calls[1].params.projectRoot, root);
  await main.call('alp_schedule', { action: 'get', id: 'sch_1234567890abcdef' });
  await main.call('alp_schedule', { action: 'cancel', id: 'sch_1234567890abcdef' });
  assert.deepEqual(calls.slice(2).map(call => call.action), ['get', 'cancel']);
});

test('rejection, malformed timezone, foreign project argument and child invocation cannot create a schedule', async t => {
  const { runtime, main, agents, calls } = await setup(t);
  assert.match((await main.call('alp_schedule', { ...draft(), dueAt: '2026-10-21T09:00:00' })).error, /UTC offset/);
  assert.match((await main.call('alp_schedule', { action: 'list', projectRoot: '/foreign' })).error, /Unknown schedule action/);
  const args = draft();
  const pending = await main.call('alp_schedule', args);
  runtime.answer(pending.approvalId, { text: 'reject' });
  await until(async () => (await main.call('alp_schedule', args)).status === 'resolved');
  assert.deepEqual(calls, []);
  await main.call('alp_delegate', { agent: 'peer', task: 'Read only', mode: 'read-only', wait: false });
  await until(() => agents[1]?.started.length === 1);
  assert.ok(!agents[1].config.dynamicTools.some(tool => tool.name === 'alp_schedule'));
  assert.match((await agents[1].call('alp_schedule', { action: 'list' })).error, /Only the main root/);
});

for (const outcome of ['timeout', 'interrupt', 'handler_error']) {
  test(`schedule approval ${outcome} never silently creates a job`, async t => {
    const { runtime, main, calls } = await setup(t);
    if (outcome === 'handler_error') runtime.bindSchedules(async () => { throw new Error('disk unavailable'); });
    const args = draft();
    const pending = await main.call('alp_schedule', args);
    if (outcome === 'interrupt') {
      await runtime.interrupt('root');
      assert.ok(!runtime.questions().some(question => question.id === pending.approvalId));
      assert.deepEqual(calls, []);
    } else {
      if (outcome === 'handler_error') runtime.answer(pending.approvalId, { text: 'approve' });
      let result;
      await until(async () => { result = await main.call('alp_schedule', args); return result.status === 'resolved'; });
      assert.equal(result.created, false);
      if (outcome === 'handler_error') assert.match(result.error, /disk unavailable/);
      else assert.equal(result.approved, false);
      assert.deepEqual(calls, []);
    }
  });
}
