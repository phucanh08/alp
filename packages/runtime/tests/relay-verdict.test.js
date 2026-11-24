// t-d8c5: in Cafe, the result of an assignment whose requester is not the root (a reviewer or
// peer the lead started) also reaches the root as a short 'relay' mail, so main reads the verdict
// its supervisor reads. A relay never wakes an idle root and never ends the root's alp_wait.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '@anhlp/alp-core/init';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { RELAY_CHARS } from '@anhlp/alp-runtime/mailbox';
import { fakeTransport, until } from '../../../test/support/fake-agent.js';
import { teardown } from '../../../test/support/teardown.js';

const settle = () => new Promise(resolve => setTimeout(resolve, 40));
const criterion = result => ({ criterion: 'Retries stop after three attempts', result, evidence: `src/retry.ts:40 ${result}` });
const failing = { result: 'fail', criteria: [criterion('fail')], findings: [{ severity: 'high', where: 'src/retry.ts:41', problem: 'Retries forever' }] };

async function setup(t, { supervisor = false } = {}) {
  const defer = teardown(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-relay-'));
  defer(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const root = path.join(directory, 'project');
  await initProject(root);
  await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify({ workflow: { mode: 'cafe', supervisor } }));
  const agents = [];
  const runtime = createAlpRuntime({ language: 'English', transport: fakeTransport(agents), libraryDir: path.join(directory, 'home'), runLogDir: path.join(directory, 'runs') });
  defer(() => runtime.shutdown());
  await runtime.open('root', { cwd: root });
  if (supervisor) await until(() => agents.length === 2, 'the supervisor');
  const main = agents[0];
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Fix retries' }] });
  await until(() => main.turnId, 'main turn');
  // main → lead → reviewer, every agent a fake: no provider runs.
  const { assignmentId: leadId } = await main.call('alp_delegate', { agent: 'lead', task: 'Fix retries and get it reviewed', mode: 'read-only', wait: false });
  assert.ok(leadId);
  await until(() => agents.at(-1) !== main && agents.at(-1).turnId, 'lead turn');
  const lead = agents.at(-1);
  const delegate = async task => {
    const count = agents.length;
    const { assignmentId } = await lead.call('alp_delegate', { agent: 'reviewer', task, wait: false });
    assert.ok(assignmentId);
    await until(() => agents.length > count && agents.at(-1).turnId, 'reviewer turn');
    return { id: assignmentId, agent: agents.at(-1) };
  };
  return { runtime, agents, main, lead, leadId, delegate };
}

test('main reads the verdict of a reviewer its lead started in the same turn, without its wait ending early', async t => {
  const { main, lead, leadId, delegate } = await setup(t);
  const reviewer = await delegate('Review the retry change');
  let mainEvents;
  // A catch-all wait, the one a relay could end if it counted as mail for main's assignments.
  const mainWait = main.call('alp_wait', {}).then(answer => { mainEvents = answer.events; });

  assert.equal((await reviewer.agent.call('alp_handoff', { outcome: 'complete', summary: 'One blocker', verdict: failing })).recorded, true);
  reviewer.agent.finish('Reviewed');
  // The direct requester gets its result as before, and only that.
  const leadAnswer = await lead.call('alp_wait', { assignments: [reviewer.id] });
  assert.deepEqual(leadAnswer.events.map(event => [event.kind, event.from, event.assignment]), [['result', 'reviewer', reviewer.id]]);
  assert.deepEqual(leadAnswer.events[0].result.handoff.verdict, failing);
  assert.equal(leadAnswer.events[0].body, undefined);

  // The relay neither ends main's wait for its lead nor steers into its turn.
  await settle();
  assert.equal(mainEvents, undefined, 'main\'s wait for its lead ended on the relay');
  assert.deepEqual(main.steered, []);

  await lead.call('alp_handoff', { outcome: 'complete', summary: 'Reviewer failed it; fixing' });
  lead.finish('Done');
  await mainWait;
  // Same wait, same turn: the relay rides with the lead's result, oldest first.
  assert.deepEqual(mainEvents.map(event => [event.kind, event.from, event.assignment]), [['relay', 'ALP', reviewer.id], ['result', 'lead', leadId]]);
  const [relay] = mainEvents;
  assert.match(relay.body, new RegExp(`^reviewer assignment ${reviewer.id} for lead completed at \\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z, handoff complete, verdict FAIL \\(0 passed, 1 failed, 1 findings\\): One blocker$`));
  // What leaves the runtime carries no internal fields.
  assert.deepEqual(Object.keys(relay).sort(), ['assignment', 'body', 'from', 'id', 'kind']);
  // The root's own child gets no relay: it was the requester.
  assert.equal(mainEvents.filter(event => event.kind === 'relay' && event.assignment === leadId).length, 0);
  // A relay is not an assignment of main's to wait for.
  assert.match((await main.call('alp_wait', { assignments: [reviewer.id], timeoutMs: 20 })).error, /Unknown assignment/);
  main.finish('ok');
});

test('a relay never wakes an idle root; it rides with the next mail, is bounded, and comes once when delivered again', async t => {
  const { runtime, main, lead, leadId, delegate } = await setup(t);
  main.finish('Waiting for the lead');
  await settle();
  assert.equal(main.started.length, 1);
  const reviewer = await delegate('Review the retry change');
  const summary = `Long review. ${'x'.repeat(5000)}`;
  await reviewer.agent.call('alp_handoff', { outcome: 'complete', summary, verdict: failing });
  reviewer.agent.finish('Reviewed');
  await lead.call('alp_wait', { assignments: [reviewer.id] });
  await settle();
  // Idle main is not woken by the relay.
  assert.equal(main.started.length, 1, 'the relay woke an idle root');

  await lead.call('alp_handoff', { outcome: 'complete', summary: 'Done' });
  lead.finish('Done');
  // The lead's result wakes main; the relay comes in the same turn, before it.
  await until(() => main.started.length === 2, 'main woken by the lead\'s result');
  const text = main.started[1].params.input.at(-1).text;
  const relayLine = text.match(/\[(#\d+)\] relay from ALP, result of assignment (\S+), which went to its requester; a copy for your information, not one of your assignments:\n(.*)/);
  assert.ok(relayLine, text);
  assert.equal(relayLine[2], reviewer.id);
  assert.ok(text.indexOf(relayLine[0]) < text.indexOf(`result from lead, assignment ${leadId}`), text);
  // Bounded: at most RELAY_CHARS characters, the summary cut short.
  assert.equal(RELAY_CHARS, 1000);
  assert.ok(relayLine[3].length <= RELAY_CHARS, `${relayLine[3].length}`);
  assert.match(relayLine[3], /verdict FAIL .*: Long review\. x+…$/);

  // The turn fails: the same relay comes again with the next prompt, once, saying when it was posted.
  main.notification('turn/completed', { threadId: main.threadId, turn: { id: main.turnId, status: 'failed', error: { message: 'boom' } } });
  await settle();
  await runtime.prompt('root', { clientMessageId: 'm2', delivery: 'auto', content: [{ type: 'text', text: 'Go on' }] });
  await until(() => main.started.length === 3, 'main\'s next turn');
  const again = main.started[2].params.input.at(-1).text;
  assert.equal(again.split(`[${relayLine[1]}] relay from ALP`).length - 1, 1, again);
  assert.match(again, new RegExp(`\\[${relayLine[1]}\\] relay from ALP, result of assignment ${reviewer.id}, [^:]*, issued \\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z, redelivered:`));
  main.finish('ok');
});

test('the supervisor digest says which grandchild results main got and which only the lead got', async t => {
  const { agents, main, lead, leadId, delegate } = await setup(t, { supervisor: true });
  const supervisor = agents[1];
  const reviewed = await delegate('Review the retry change');
  const dropped = await delegate('Review the docs');
  const mainWait = main.call('alp_wait', { assignments: [leadId] });

  await reviewed.agent.call('alp_handoff', { outcome: 'complete', summary: 'One blocker', verdict: failing });
  reviewed.agent.finish('Reviewed');
  await lead.call('alp_wait', { assignments: [reviewed.id] });
  // Cancelled by the lead: no result for anyone, so no relay to main either.
  await lead.call('alp_cancel', { assignmentId: dropped.id, reason: 'Not needed' });
  await lead.call('alp_handoff', { outcome: 'complete', summary: 'Reviewed; fixing' });
  lead.finish('Done');
  const answer = await mainWait;
  assert.deepEqual(answer.events.map(event => [event.kind, event.assignment]), [['relay', reviewed.id], ['result', leadId]]);
  main.finish('Lead reported; reviewer failed it');
  await until(() => supervisor.started.length === 1, 'the review of main\'s turn');
  const digest = supervisor.started[0].params.input.at(-1).text;
  const line = id => digest.split('\n').find(text => text.includes(`assignment ${id} `) && !text.includes(' → '));
  assert.match(line(reviewed.id), /reviewer assignment \S+ completed, handoff complete, verdict FAIL .*: One blocker \(also relayed to main\)$/);
  assert.match(line(dropped.id), /reviewer assignment \S+ canceled, no handoff \(Canceled by lead: Not needed\) \(result went to lead, not to main\)$/);
  // Main's own lead: main was its requester, no mark.
  assert.match(line(leadId), /lead assignment \S+ completed, handoff complete: Reviewed; fixing$/);
  // The relay itself is not a second digest line.
  assert.doesNotMatch(digest, /mail relay/);
});
