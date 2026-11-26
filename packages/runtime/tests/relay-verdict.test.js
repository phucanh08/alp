// t-d8c5: in Cafe, the result of an assignment whose requester is not the root (a reviewer or
// peer the lead started) also reaches the root as a short 'relay' mail, so main reads the verdict
// its supervisor reads. A relay never wakes an idle root and never ends the root's alp_wait.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '@anhlp/alp-core/init';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { RELAY_CHARS } from '@anhlp/alp-runtime/mailbox';
import { fakeTransport, until } from '../../../test/support/fake-agent.ts';
import { teardown } from '../../../test/support/teardown.ts';

const criterion = result => ({ criterion: 'Retries stop after three attempts', result, evidence: `src/retry.ts:40 ${result}` });
const failing = { result: 'fail', criteria: [criterion('fail')], findings: [{ severity: 'high', where: 'src/retry.ts:41', problem: 'Retries forever' }] };

async function setup(t, { supervisor = false, liveFile } = {}) {
  const defer = teardown(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-relay-'));
  defer(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const root = path.join(directory, 'project');
  await initProject(root);
  await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify({ workflow: { mode: 'cafe', supervisor } }));
  const agents = [];
  const options = { language: 'English', libraryDir: path.join(directory, 'home'), runLogDir: path.join(directory, 'runs'), ...(liveFile ? { liveFile: path.join(directory, liveFile) } : {}) };
  const runtime = createAlpRuntime({ ...options, transport: fakeTransport(agents) });
  defer(() => runtime.shutdown());
  await runtime.open('root', { cwd: root, ...(liveFile ? { persist: true } : {}) });
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
  // An idle root on the same queue: once recover() of it returns, any wake queued before it has
  // run, and a steer or an ended wait happens in post() itself. So "nothing woke" is awaited, not timed.
  let barrierOpen;
  const barrier = async () => {
    barrierOpen ??= runtime.open('barrier', { cwd: root });
    await barrierOpen;
    await runtime.recover('barrier');
  };
  return { runtime, agents, main, lead, leadId, delegate, barrier, defer, directory, root, options };
}

test('main reads the verdict of a reviewer its lead started in the same turn, without its wait ending early', async t => {
  const { main, lead, leadId, delegate, barrier } = await setup(t);
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
  await barrier();
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
  const { runtime, main, lead, leadId, delegate, barrier } = await setup(t);
  main.finish('Waiting for the lead');
  await barrier();
  assert.equal(main.started.length, 1);
  const reviewer = await delegate('Review the retry change');
  const summary = `Long review. ${'x'.repeat(5000)}`;
  await reviewer.agent.call('alp_handoff', { outcome: 'complete', summary, verdict: failing });
  reviewer.agent.finish('Reviewed');
  await lead.call('alp_wait', { assignments: [reviewer.id] });
  await barrier();
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
  await until(() => !runtime.snapshot('root').activeTurnId, 'main\'s failed turn ended');
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
  assert.match(line(reviewed.id), /reviewer assignment \S+ completed, handoff complete, verdict FAIL .*: One blocker \(relay to main posted; not yet in main's input\)$/);
  // main's completed turn took the relay with the lead's result: the digest says it received it.
  assert.match(digest, new RegExp(`main received the relay of reviewer assignment ${reviewed.id} \\(its result went to lead\\)`));
  assert.doesNotMatch(digest, new RegExp(`received the relay of reviewer assignment ${dropped.id}`));
  assert.match(line(dropped.id), /reviewer assignment \S+ canceled, no handoff \(Canceled by lead: Not needed\) \(result went to lead, not to main\)$/);
  // Main's own lead: main was its requester, no mark.
  assert.match(line(leadId), /lead assignment \S+ completed, handoff complete: Reviewed; fixing$/);
  // The relay itself is not a second digest line.
  assert.doesNotMatch(digest, /mail relay/);
});

// The real Cafe run of 25/11: main delegated to its lead with wait: true, and the relay of the
// reviewer's verdict was taken out of main's mailbox with the lead's result but never shown.
test('a relay that comes while the root waits in alp_delegate wait: true is in that call\'s result, and the digest says main got it', async t => {
  const defer = teardown(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-relay-'));
  defer(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const root = path.join(directory, 'project');
  await initProject(root);
  await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify({ workflow: { mode: 'cafe', supervisor: true } }));
  const agents = [];
  const runtime = createAlpRuntime({ language: 'English', libraryDir: path.join(directory, 'home'), runLogDir: path.join(directory, 'runs'), transport: fakeTransport(agents) });
  defer(() => runtime.shutdown());
  await runtime.open('root', { cwd: root });
  await until(() => agents.length === 2, 'the supervisor');
  const [main, supervisor] = agents;
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Fix retries' }] });
  await until(() => main.turnId, 'main turn');

  // main waits in the delegate call itself, as the real main did.
  const delegated = main.call('alp_delegate', { agent: 'lead', task: 'Fix retries and get it reviewed', mode: 'read-only', wait: true });
  await until(() => agents.length === 3 && agents[2].turnId, 'lead turn');
  const lead = agents[2];
  const { assignmentId: reviewerId } = await lead.call('alp_delegate', { agent: 'reviewer', task: 'Review the retry change', wait: false });
  await until(() => agents.length === 4 && agents[3].turnId, 'reviewer turn');
  const reviewer = agents[3];
  await reviewer.call('alp_handoff', { outcome: 'complete', summary: 'One blocker', verdict: failing });
  reviewer.finish('Reviewed');
  await lead.call('alp_wait', { assignments: [reviewerId] });
  await lead.call('alp_handoff', { outcome: 'complete', summary: 'Reviewer failed it; fixing' });
  lead.finish('Done');

  const result = await delegated;
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.handoff.summary, 'Reviewer failed it; fixing');
  // The relay taken with the lead's result is shown in the same tool result, not dropped.
  const relays = (result.mail ?? []).filter(event => event.kind === 'relay');
  assert.deepEqual(relays.map(event => [event.from, event.assignment]), [['ALP', reviewerId]], JSON.stringify(result));
  assert.match(relays[0].body, new RegExp(`^reviewer assignment ${reviewerId} for lead completed at [^,]+, handoff complete, verdict FAIL .*: One blocker$`));
  assert.deepEqual(Object.keys(relays[0]).sort(), ['assignment', 'body', 'from', 'id', 'kind']);

  main.finish('Lead reported; reviewer failed it');
  await until(() => supervisor.started.length === 1, 'the review of main\'s turn');
  const digest = supervisor.started[0].params.input.at(-1).text;
  const finished = digest.split('\n').find(line => line.includes(`assignment ${reviewerId} `) && !line.includes(' → ')) ?? digest;
  // Posted is not received: the finish line says only that the relay was posted ...
  assert.match(finished, /reviewer assignment \S+ completed, handoff complete, verdict FAIL .*: One blocker \(relay to main posted; not yet in main's input\)$/);
  // ... and the digest says main received it once its completed turn took it.
  assert.match(digest, new RegExp(`main received the relay of reviewer assignment ${reviewerId} \\(its result went to lead\\)`));
});

test('a relay that comes with the child\'s question to a root in alp_delegate wait: true is shown with the question', async t => {
  const defer = teardown(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-relay-'));
  defer(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const root = path.join(directory, 'project');
  await initProject(root);
  await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify({ workflow: { mode: 'cafe', supervisor: false } }));
  const agents = [];
  const runtime = createAlpRuntime({ language: 'English', libraryDir: path.join(directory, 'home'), runLogDir: path.join(directory, 'runs'), transport: fakeTransport(agents) });
  defer(() => runtime.shutdown());
  await runtime.open('root', { cwd: root });
  const [main] = agents;
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Fix retries' }] });
  await until(() => main.turnId, 'main turn');
  const delegated = main.call('alp_delegate', { agent: 'lead', task: 'Fix retries and get it reviewed', mode: 'read-only', wait: true });
  await until(() => agents.length === 2 && agents[1].turnId, 'lead turn');
  const lead = agents[1];
  const { assignmentId: reviewerId } = await lead.call('alp_delegate', { agent: 'reviewer', task: 'Review the retry change', wait: false });
  await until(() => agents.length === 3 && agents[2].turnId, 'reviewer turn');
  await agents[2].call('alp_handoff', { outcome: 'complete', summary: 'One blocker', verdict: failing });
  agents[2].finish('Reviewed');
  await lead.call('alp_wait', { assignments: [reviewerId] });
  // The lead asks main; main's delegate wait ends on the question, and the relay comes with it.
  const asked = lead.call('alp_ask', { question: 'Fix the blocker or ship?' });
  const answer = await delegated;
  assert.deepEqual(answer.events.map(event => [event.kind, event.assignment]), [['relay', reviewerId], ['question', answer.assignmentId]], JSON.stringify(answer));
  assert.match(answer.events[0].body, /verdict FAIL .*: One blocker$/);
  await main.call('alp_send', { to: answer.assignmentId, kind: 'answer', replyTo: answer.events[1].id, body: 'Fix it' });
  assert.match(JSON.stringify(await asked), /Fix it/);
  await lead.call('alp_handoff', { outcome: 'complete', summary: 'Fixed' });
  lead.finish('Done');
  // The relay is not shown twice: the result that ends main's next wait comes alone.
  const done = await main.call('alp_wait', { assignments: [answer.assignmentId] });
  assert.deepEqual(done.events.map(event => event.kind), ['result']);
  main.finish('ok');
});

test('a relay main has not read yet is not called relayed in the digest; the next turn that takes it is', async t => {
  const { agents, main, lead, leadId, delegate, barrier } = await setup(t, { supervisor: true });
  const supervisor = agents[1];
  const reviewer = await delegate('Review the retry change');
  // main is busy outside any wait: the passive relay neither steers nor ends anything.
  await reviewer.agent.call('alp_handoff', { outcome: 'complete', summary: 'One blocker', verdict: failing });
  reviewer.agent.finish('Reviewed');
  await lead.call('alp_wait', { assignments: [reviewer.id] });
  await barrier();
  assert.deepEqual(main.steered, []);
  main.finish('Still working');
  await until(() => supervisor.started.length === 1, 'the review of main\'s first turn');
  const first = supervisor.started[0].params.input.at(-1).text;
  assert.match(first, new RegExp(`reviewer assignment ${reviewer.id} completed, .*\\(relay to main posted; not yet in main's input\\)`));
  assert.doesNotMatch(first, /also relayed|received the relay/);

  // The lead's result wakes main; the relay rides with it and that turn's digest says main got it.
  await lead.call('alp_handoff', { outcome: 'complete', summary: 'Done' });
  lead.finish('Done');
  await until(() => main.started.length === 2, 'main woken by the lead\'s result');
  assert.match(main.started[1].params.input.at(-1).text, new RegExp(`relay from ALP, result of assignment ${reviewer.id},`));
  supervisor.finish('Reviewed');
  main.finish('Lead reported');
  await until(() => supervisor.started.length === 2, 'the review of main\'s second turn');
  const second = supervisor.started[1].params.input.at(-1).text;
  assert.match(second, new RegExp(`main received the relay of reviewer assignment ${reviewer.id} \\(its result went to lead\\)`));
  assert.match(second, new RegExp(`lead assignment ${leadId} completed`));
});

test('a grandchild alpd abandons after a restart is relayed to the root once, and the digest says so', async t => {
  const { runtime: first, agents, main, lead, leadId, delegate, defer, directory, root, options } = await setup(t, { supervisor: true, liveFile: 'live.json' });
  const reviewer = await delegate('Review the retry change');
  const live = () => readFile(path.join(directory, 'live.json'), 'utf8').then(JSON.parse, () => []);
  await until(async () => (await live()).length === 2, 'lead and reviewer in the live file');
  const { runtime: runtimeKind, model } = first.snapshot('root');
  // alpd stops while the lead and its reviewer work; both stay in the live file.
  await first.shutdown();
  assert.deepEqual((await live()).map(entry => entry.assignmentId).sort(), [leadId, reviewer.id].sort());

  // The next alpd: the lead's thread resumes, the reviewer's cannot, so the reviewer is abandoned.
  const next = [];
  const fake = fakeTransport(next);
  const transport = (...args) => {
    const agent = fake(...args);
    const request = agent.request.bind(agent);
    agent.request = async (method, params) => {
      if (method === 'thread/resume' && params.threadId === reviewer.agent.threadId) throw new Error('thread not found');
      return request(method, params);
    };
    return agent;
  };
  const runtime = createAlpRuntime({ ...options, transport });
  defer(() => runtime.shutdown());
  await runtime.open('root', { cwd: root, persist: true, restore: { agent: 'main', threadId: main.threadId, runtime: runtimeKind, model } });
  const outcomes = await runtime.recover('root');
  assert.deepEqual(outcomes.map(outcome => [outcome.assignmentId, outcome.outcome]), [[leadId, 'resumed'], [reviewer.id, 'failed']]);
  const mainAgain = next.find(agent => agent.threadId === main.threadId);
  const leadAgain = next.find(agent => agent.threadId === lead.threadId);
  assert.ok(mainAgain && leadAgain);
  // The lead gets the failed result; main, idle, is not woken by the relay (same queue barrier as above).
  await until(() => leadAgain.turnId, 'the lead continues');
  await runtime.open('barrier', { cwd: root });
  await runtime.recover('barrier');
  assert.equal(mainAgain.started.length, 0, 'the relay woke an idle root');

  await leadAgain.call('alp_handoff', { outcome: 'complete', summary: 'Reviewer lost in the restart' });
  leadAgain.finish('Done');
  await until(() => mainAgain.started.length === 1, 'main woken by the lead\'s result');
  const text = mainAgain.started[0].params.input.at(-1).text;
  // Exactly once, before the lead's result, saying the reviewer failed in the restart.
  assert.equal(text.split(`relay from ALP, result of assignment ${reviewer.id},`).length - 1, 1, text);
  assert.match(text, new RegExp(`reviewer assignment ${reviewer.id} for lead failed at [^,]+, no handoff \\(alpd [^)]*could not continue: thread not found\\)`));
  assert.ok(text.indexOf(`assignment ${reviewer.id},`) < text.indexOf(`result from lead, assignment ${leadId}`), text);
  mainAgain.finish('Lead reported');
  // The supervisor is the one other agent that runs a turn.
  let supervisor;
  await until(() => (supervisor = next.find(agent => agent !== mainAgain && agent !== leadAgain && agent.started.length)), 'the review of main\'s turn');
  const digest = supervisor.started[0].params.input.at(-1).text;
  assert.match(digest.split('\n').find(line => line.includes(`assignment ${reviewer.id} `) && !line.includes(' → ')) ?? digest, /reviewer assignment \S+ failed, no handoff \(.*\) \(relay to main posted; not yet in main's input\)$/);
  assert.equal(digest.split(`main received the relay of reviewer assignment ${reviewer.id} (its result went to lead)`).length - 1, 1, digest);
});
