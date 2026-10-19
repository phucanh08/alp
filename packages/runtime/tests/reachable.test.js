import test from 'node:test';
import assert from 'node:assert/strict';
import { tree, until } from '../../../test/support/fake-agent.js';

/**
 * Main stays reachable while its assignments run (ALPD §48): the user's words end its
 * waits, check-ins keep it and the user posted, and an ETA it gave is held to.
 */
const steer = (runtime, text) => runtime.prompt('root', { clientMessageId: `steer-${text}`, delivery: 'steer', content: [{ type: 'text', text }] });
const peerHandoff = { outcome: 'complete', summary: 'Done' };

test('the final background result wakes idle main after more than eight assignment completions', async t => {
  const { runtime, agents, main } = await tree(t, { options: () => ({ checkInMs: 0 }) });
  const results = [];
  runtime.onEvent(({ sessionId, event }) => {
    if (sessionId === 'root' && event.type === 'mail' && event.mail.kind === 'result') results.push(event.mail);
  });
  // Each round is a real background delegation and a completed wake turn, with no
  // intervening user prompt or check-in to rescue the last result.
  for (let round = 1; round <= 10; round++) {
    const delegated = await main.call('alp_delegate', { agent: 'peer', task: `Job ${round}`, mode: 'read-only' });
    assert.equal(delegated.status, 'running');
    await until(() => agents[round]?.started.length, `job ${round} to start`);
    main.finish(`Job ${round} is running.`);
    await agents[round].call('alp_handoff', peerHandoff);
    agents[round].finish(`completed job ${round}`);
    await until(() => results.length === round, `job ${round} result to be posted`);
    await until(() => main.started.length === round + 1, `job ${round} result to wake main`);
    const text = main.started.at(-1).params.input.at(-1).text;
    assert.ok(text.includes(delegated.assignmentId));
    assert.ok(text.includes(`completed job ${round}`));
    assert.match(text, /result from peer/);
  }
  main.finish('All results received.');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(main.started.length, 11, 'acknowledged results do not start duplicate turns');
  assert.equal(runtime.snapshot('root').busy, false, 'no result or assignment remains outstanding');
});

// Exercise the real retry guard without changing private counters: one message
// whose turn/start repeatedly fails consumes eight wakes, then stays queued.
async function exhaustWakes(runtime, main) {
  main.finish('Work continues in the background.');
  const request = main.request;
  let attempts = 0;
  main.request = async function(method, params) {
    if (method === 'turn/start') { attempts++; throw new Error('Provider temporarily unavailable'); }
    return request.call(this, method, params);
  };
  runtime.message('root', 'Please report when done.');
  await until(() => attempts >= 8, 'eight failed wake requests');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(attempts, 8, 'the same undelivered mail cannot retry forever');
  main.request = request;
}

test('a new assignment question renews delivery after exhausted retries, and its result still wakes main', async t => {
  const { runtime, agents, main } = await tree(t, { options: () => ({ checkInMs: 0 }) });
  const { assignmentId } = await main.call('alp_delegate', { agent: 'peer', task: 'Ask then finish', mode: 'read-only' });
  await until(() => agents[1]?.started.length);
  await exhaustWakes(runtime, main);
  const answer = agents[1].call('alp_ask', { question: 'Which output?' });
  await until(() => main.started.length === 2, 'the new question wake');
  const text = main.started.at(-1).params.input.at(-1).text;
  assert.match(text, /question from peer[\s\S]*Which output\?/);
  assert.match(text, /Please report when done/);
  const replyTo = text.match(/\[(#\d+)\] question from peer/)[1];
  await main.call('alp_send', { to: assignmentId, kind: 'answer', replyTo, body: 'JSON' });
  assert.equal((await answer).answer, 'JSON');
  main.finish('The peer has its answer.');
  await agents[1].call('alp_handoff', peerHandoff);
  agents[1].finish('JSON produced');
  await until(() => main.started.length === 3, 'the final result wake');
  assert.match(main.started.at(-1).params.input.at(-1).text, /JSON produced/);
});

test('check-ins reach idle main after exhausted retries without renewing its retry allowance', async t => {
  const { runtime, agents, main } = await tree(t, { options: () => ({ checkInMs: 60_000, watchMs: 10, silentForMs: 3_600_000 }) });
  await main.call('alp_delegate', { agent: 'peer', task: 'Long job', mode: 'read-only' });
  await until(() => agents[1]?.started.length);
  await exhaustWakes(runtime, main);
  const real = Date.now;
  t.after(() => { Date.now = real; });
  Date.now = () => real() + 61_000;
  await until(() => main.started.length === 2, 'a check-in after the budget is exhausted');
  assert.match(main.started.at(-1).params.input.at(-1).text, /check-in from ALP/);
  main.finish('Still working.');
  // New ordinary mail still cannot wake main: the check-in did not renew it.
  runtime.message('root', 'Another status note');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(main.started.length, 2);
});

test('a check-in after exhausted retries has bounded failed starts and a fresh check-in can recover', async t => {
  const { runtime, agents, main } = await tree(t, { options: () => ({ checkInMs: 60_000, watchMs: 10, silentForMs: 3_600_000 }) });
  await main.call('alp_delegate', { agent: 'peer', task: 'Long job', mode: 'read-only' });
  await until(() => agents[1]?.started.length);
  await exhaustWakes(runtime, main);
  const request = main.request;
  let attempts = 0;
  main.request = async function(method, params) {
    if (method === 'turn/start') { attempts++; throw new Error('Provider is still unavailable'); }
    return request.call(this, method, params);
  };
  const real = Date.now;
  t.after(() => { Date.now = real; main.request = request; });
  Date.now = () => real() + 61_000;
  await until(() => attempts >= 8, 'check-in delivery attempts');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(attempts, 8, 'the same check-in cannot bypass the failed-start limit');
  main.request = request;
  Date.now = () => real() + 122_000;
  await until(() => main.started.length === 2, 'fresh check-in to renew the failed-start allowance');
  assert.match(main.started.at(-1).params.input.at(-1).text, /check-in from ALP/);
});

test('a check-in beyond the first mail batch wakes exhausted main and delivers the backlog', async t => {
  const { runtime, agents, main } = await tree(t, { options: () => ({ checkInMs: 60_000, watchMs: 10, silentForMs: 3_600_000 }) });
  await main.call('alp_delegate', { agent: 'peer', task: 'Long job', mode: 'read-only' });
  await until(() => agents[1]?.started.length);
  await exhaustWakes(runtime, main);
  const older = 'older backlog ' + 'x'.repeat(7900);
  const newer = 'newer backlog ' + 'y'.repeat(7900);
  runtime.message('root', older);
  runtime.message('root', newer);
  const real = Date.now;
  t.after(() => { Date.now = real; });
  Date.now = () => real() + 61_000;
  await until(() => main.started.length === 2, 'check-in beyond the capped batch to wake main');
  const received = () => [...main.started.slice(1).map(call => call.params.input.at(-1).text), ...main.steered].join('\n');
  await until(() => received().includes('check-in from ALP') && received().includes(older) && received().includes(newer), 'the check-in and both complete backlog messages');
  main.finish('Backlog received.');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(main.started.length, 2, 'the backlog does not create duplicate turns');
});

test('concurrent final results reach a pending user turn without duplicate wakes', async t => {
  const { runtime, agents, main } = await tree(t, { options: () => ({ checkInMs: 0 }) });
  for (const task of ['A', 'B']) await main.call('alp_delegate', { agent: 'peer', task, mode: 'read-only' });
  await until(() => agents[2]?.started.length);
  await exhaustWakes(runtime, main);
  const request = main.request;
  let pending = false;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  main.request = async function(method, params) {
    if (method === 'turn/start') { pending = true; await gate; }
    return request.call(this, method, params);
  };
  const posted = [];
  runtime.onEvent(({ sessionId, event }) => {
    if (sessionId === 'root' && event.type === 'mail' && event.mail.kind === 'result') posted.push(event.mail);
  });
  const prompt = runtime.prompt('root', { clientMessageId: 'concurrent-user', delivery: 'auto', content: [{ type: 'text', text: 'Status?' }] });
  await until(() => pending, 'the user prompt to be pending');
  agents[1].finish('parallel result A');
  agents[2].finish('parallel result B');
  await until(() => posted.length === 2, 'both final results to post');
  release();
  await prompt;
  await until(() => main.steered.join('\n').includes('parallel result A') && main.steered.join('\n').includes('parallel result B'), 'both results in the running turn');
  main.finish('Both results received.');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(main.started.length, 2, 'only the user prompt starts a turn');
  assert.equal(runtime.snapshot('root').busy, false, 'both results are acknowledged');
});

test('the user\'s message ends main\'s wait for an assignment, which keeps running', async t => {
  const { runtime, agents, main } = await tree(t, { options: () => ({ checkInMs: 0 }) });
  const waiting = main.call('alp_delegate', { agent: 'peer', task: 'Do the long job', mode: 'read-only', wait: true });
  await until(() => agents[1]?.started.length, 'the peer to start');
  await steer(runtime, 'How is it going?');
  const early = await waiting;
  assert.equal(early.status, 'running');
  assert.equal(early.userMessage, true);
  assert.match(early.next, /Answer them first/);
  assert.deepEqual(main.calls.filter(call => call.method === 'turn/steer').map(call => call.params.input.at(-1).text), ['How is it going?']);
  assert.equal(agents[1].closed, false, 'the assignment keeps running');

  // alp_wait ends early the same way, then collects the result.
  const wait = main.call('alp_wait', { timeoutMs: 60_000 });
  await steer(runtime, 'Also add a README');
  const released = await wait;
  assert.equal(released.userMessage, true);
  assert.deepEqual(released.running.map(entry => [entry.agent, entry.status]), [['peer', 'running']]);
  const result = main.call('alp_wait', { timeoutMs: 60_000 });
  await agents[1].call('alp_handoff', peerHandoff);
  agents[1].finish('finished');
  const [event] = (await result).events;
  assert.equal(event.kind, 'result');
  assert.equal(event.result.output, 'finished');
});

test('main gets a check-in while assignments run, and check-ins do not use up its wakes', async t => {
  const { agents, main, runLog } = await tree(t, { options: () => ({ checkInMs: 40, silentForMs: 3_600_000 }) });
  const { assignmentId } = await main.call('alp_delegate', { agent: 'peer', task: 'Do the long job', mode: 'read-only', wait: false, etaMinutes: 30 });
  await until(() => agents[1]?.started.length, 'the peer to start');
  await agents[1].call('alp_send', { to: 'parent', kind: 'note', body: 'Halfway through the parser' });
  main.finish('Started peer on it; I will report back.');
  // More check-ins than the wake limit (8) each wake main, which finishes its turn.
  for (let wake = 1; wake <= 10; wake++) {
    await until(() => main.started.length === 1 + wake, `check-in wake ${wake}`);
    const text = main.started.at(-1).params.input.at(-1).text;
    assert.match(text, /check-in from ALP/);
    assert.match(text, new RegExp(`peer \\(${assignmentId}\\): running \\d+ s; last activity \\d+ s ago; ETA in 30 min; last note: Halfway through the parser`));
    assert.match(text, /Tell the user in one or two lines how the work is going/);
    main.finish('Peer is still on the parser.');
  }
  // The result still wakes main.
  await agents[1].call('alp_handoff', peerHandoff);
  agents[1].finish('parser done');
  await until(() => main.started.at(-1).params.input.at(-1).text.includes('parser done'), 'the result wake');
  assert.ok((await runLog()).some(entry => entry.event === 'mail' && entry.kind === 'checkin'));
});

test('an assignment past the ETA its requester gave ends the requester\'s wait with a check-in, once', async t => {
  const { agents, main } = await tree(t, { options: () => ({ checkInMs: 0, silentForMs: 3_600_000, watchMs: 10 }) });
  // ALP's timers do not hold the process open; this does while the test awaits them.
  const alive = setInterval(() => {}, 1000);
  t.after(() => clearInterval(alive));
  for (const etaMinutes of [0, 1441, 1.5, '5']) {
    assert.match((await main.call('alp_delegate', { agent: 'peer', task: 'x', mode: 'read-only', etaMinutes })).error, /Invalid assignment/);
  }
  const real = Date.now;
  t.after(() => { Date.now = real; });
  const waiting = main.call('alp_delegate', { agent: 'peer', task: 'Quick fix', mode: 'read-only', etaMinutes: 1, wait: true });
  await until(() => agents[1]?.started.length, 'the peer to start');
  Date.now = () => real() + 61_000;
  const late = await waiting;
  assert.equal(late.status, 'running');
  assert.match(late.next, /Not a result: the assignment keeps running/);
  assert.equal(late.events[0].kind, 'checkin');
  assert.match(late.events[0].body, /^1 assignment still running; peer past the ETA you gave:/);
  assert.match(late.events[0].body, /past its ETA by \d+ s/);
  // Once: a later wait sees the result, not another check-in.
  const result = main.call('alp_wait', { timeoutMs: 60_000 });
  await new Promise(resolve => setTimeout(resolve, 100));
  await agents[1].call('alp_handoff', peerHandoff);
  agents[1].finish('fixed');
  assert.deepEqual((await result).events.map(event => event.kind), ['result']);
});

test('main is told to ask once about unclear requests and to stay reachable while others work', async t => {
  const { main } = await tree(t);
  const instructions = main.config.developerInstructions;
  assert.match(instructions, /Unclear requests: .*ask once before you plan or delegate/);
  assert.match(instructions, /offer to decide with those defaults/);
  assert.match(instructions, /Stay reachable while others work, as a chat where work runs in the background\. .*Then end your turn rather than wait/);
  assert.match(instructions, /Background first: run long shell commands/);
  assert.match(instructions, /by default alp_delegate starts the assignment and returns its assignmentId at once/);
  const delegate = main.config.dynamicTools.find(tool => tool.name === 'alp_delegate');
  assert.equal(delegate.inputSchema.properties.etaMinutes.maximum, 1440);
});

test('a steer from its requester ends a lead\'s wait for its peer, which keeps running', async t => {
  const { agents, main } = await tree(t, { open: { workflow: 'cafe' }, options: () => ({ checkInMs: 0 }) });
  // Background is the default: main gets the assignment id at once.
  const { assignmentId: leadId, status } = await main.call('alp_delegate', { agent: 'lead', task: 'Build the site' });
  assert.equal(status, 'running');
  await until(() => agents[1]?.started.length, 'lead to start');
  const lead = agents[1];
  // Lead waits for its peer, then for a named assignment.
  const waiting = lead.call('alp_delegate', { agent: 'peer', task: 'Write the pages', mode: 'read-only', wait: true });
  await until(() => agents[2]?.started.length, 'peer to start');
  await main.call('alp_send', { to: leadId, kind: 'steer', body: 'The user wants a Notion-like style' });
  const early = await waiting;
  assert.equal(early.status, 'running');
  assert.deepEqual(early.events.map(event => [event.kind, event.from, event.body]), [['steer', 'main', 'The user wants a Notion-like style']]);
  assert.match(early.next, /pass that on with alp_send/);
  assert.equal(agents[2].closed, false, 'the peer keeps running');
  const named = lead.call('alp_wait', { assignments: [early.assignmentId], timeoutMs: 60_000 });
  await main.call('alp_send', { to: leadId, kind: 'note', body: 'Also a dark mode' });
  assert.deepEqual((await named).events.map(event => event.body), ['Also a dark mode']);
});

test('notes from running assignments ride with main\'s next turn instead of waking it', async t => {
  const { agents, main } = await tree(t, { options: () => ({ checkInMs: 0 }) });
  await main.call('alp_delegate', { agent: 'peer', task: 'Long job', mode: 'read-only' });
  await until(() => agents[1]?.started.length, 'the peer to start');
  main.finish('Peer is on it.');
  await agents[1].call('alp_send', { to: 'parent', kind: 'note', body: 'Halfway' });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(main.started.length, 1, 'a note does not wake main');
  await agents[1].call('alp_handoff', peerHandoff);
  agents[1].finish('all done');
  await until(() => main.started.length === 2, 'the result wake');
  const text = main.started[1].params.input.at(-1).text;
  assert.match(text, /note from peer[\s\S]*Halfway[\s\S]*result from peer/);
});

test('while the user waits a minute for main\'s first words, every ALP tool result reminds main to answer', async t => {
  const { runtime, main } = await tree(t, { options: () => ({ checkInMs: 0 }) });
  await steer(runtime, 'Sao rồi e ơi');
  assert.equal((await main.call('alp_board', {})).userWaiting, undefined, 'not within the first minute');
  const real = Date.now;
  t.after(() => { Date.now = real; });
  Date.now = () => real() + 61_000;
  const reminded = await main.call('alp_board', {});
  assert.match(reminded.userWaiting, /^The user wrote to you at \d\d:\d\d:\d\d and has had no reply for \d+ s\. Before more tool calls, answer them in a short message they can read/);
  // Words the user can read end the reminders.
  main.notification('item/completed', { threadId: main.threadId, item: { type: 'agentMessage', id: 'reply', text: 'Lead đang review, khoảng 10 phút nữa xong ạ.' } });
  assert.equal((await main.call('alp_board', {})).userWaiting, undefined);
});

test('Claude adopts a turn it starts by itself, as after a background task ended (ALPD §56)', async () => {
  const { ClaudeTransport } = await import('@anhlp/alp-runtime');
  const { tmpdir } = await import('node:os');
  const transport = new ClaudeTransport(process.execPath, tmpdir(), process.env);
  const seen = [];
  transport.onNotification((method, params) => (method === 'turn/started' || method === 'turn/completed') && seen.push([method, params.turn.id]));
  const assistant = (parent = null) => ({ type: 'assistant', parent_tool_use_id: parent, message: { id: `m${seen.length}`, content: [{ type: 'text', text: 'CI is green' }] } });
  // A sub-agent's message starts nothing; the session's own does, once.
  transport.handle(assistant('tool-1'));
  transport.handle(assistant());
  transport.handle(assistant());
  transport.handle({ type: 'result', subtype: 'success', is_error: false });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map(([method]) => method), ['turn/started', 'turn/completed']);
  assert.equal(seen[0][1], seen[1][1]);
});

test('ALP follows a turn the runtime started by itself: its tools work and its end is a turn end', async t => {
  const { runtime, main, runLog } = await tree(t, { options: () => ({ checkInMs: 0 }) });
  const events = [];
  runtime.onEvent(envelope => envelope.sessionId === 'root' && events.push(envelope.event));
  main.finish('Watching CI in the background.');
  await until(() => events.some(event => event.type === 'turn.ended'), 'the first turn to end');
  // The background command ends; Claude answers in a turn ALP did not start.
  main.turnId = 'native-turn';
  main.notification('turn/started', { threadId: main.threadId, turn: { id: 'native-turn' } });
  assert.deepEqual(events.at(-1), { type: 'turn.started', turnId: 'native-turn', origin: 'runtime' });
  const board = await main.call('alp_board', {});
  assert.equal(board.error, undefined, JSON.stringify(board));
  main.finish('CI is green; closing the task.');
  await until(() => events.filter(event => event.type === 'turn.ended').length === 2, 'the native turn to end');
  assert.equal(events.at(-1).turnId, 'native-turn');
  // A turn ALP knows of is not taken over by one the runtime reports.
  await runtime.prompt('root', { clientMessageId: 'm2', delivery: 'auto', content: [{ type: 'text', text: 'Next' }] });
  main.notification('turn/started', { threadId: main.threadId, turn: { id: 'late' } });
  assert.notEqual(events.at(-1).turnId, 'late');
  assert.ok((await runLog()).length);
});

// #116 (2026-10-17 20:56): the user wrote during a long alp_wait, main's turn ended with
// "Turn ended", and its running lead was canceled without a handoff. Ending main's turn, by any
// route short of the user's explicit stop, must leave its assignments running; their results
// later wake main as mail.
test('main\'s turn ending while it waits never cancels its running assignment (#116)', async t => {
  for (const scenario of ['alp_wait, user steers, turn completes', 'wait true, user steers, turn completes', 'alp_wait pending as turn completes', 'alp_wait pending as turn fails', 'wait true pending as turn completes', 'user prompt while busy']) {
    await t.test(scenario, async t => {
      const { runtime, agents, main } = await tree(t, { options: () => ({ checkInMs: 0, silentForMs: 3_600_000 }) });
      const ended = [];
      runtime.onEvent(({ sessionId, event }) => sessionId === 'root' && event.type === 'turn.ended' && ended.push(event.state));
      const blocking = scenario.startsWith('wait true');
      const delegated = main.call('alp_delegate', { agent: 'peer', task: 'Long job', mode: 'read-only', ...(blocking ? { wait: true } : {}) });
      await until(() => agents[1]?.started.length, 'the peer to start');
      const assignmentId = runtime.status('root').assignments[0].id;
      const waiting = blocking ? delegated : (await delegated, main.call('alp_wait', { timeoutMs: 3_000_000 }));
      // The tool call is waiting before anything else happens.
      await new Promise(resolve => setTimeout(resolve, 30));
      if (scenario.includes('user steers')) {
        await steer(runtime, 'Sao rồi e');
        const early = await waiting;
        assert.equal(early.userMessage, true);
        main.finish('Peer is still on it; I will report when it finishes.');
      } else if (scenario === 'user prompt while busy') {
        // A plain prompt to a busy turn is refused; it must not stop the work either.
        await runtime.prompt('root', { clientMessageId: 'busy', delivery: 'auto', content: [{ type: 'text', text: 'Sao rồi e' }] });
        main.finish('Peer is still on it.');
        assert.match(JSON.stringify(await waiting), /Turn ended/);
      } else {
        // The native turn ends while the tool still waits (a provider that ends its turn on its own).
        main.notification('item/completed', { threadId: main.threadId, item: { type: 'agentMessage', id: 'reply', text: 'Still working.' } });
        main.notification('turn/completed', { threadId: main.threadId, turn: { id: main.turnId, status: scenario.endsWith('fails') ? 'failed' : 'completed', ...(scenario.endsWith('fails') ? { error: { message: 'stream closed' } } : {}) } });
        const result = await waiting;
        await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal(agents[1].closed, false, 'the assignment keeps running');
        // What the ended tool call says must match: the assignment was not canceled.
        assert.match(result.error, /Turn ended/, JSON.stringify(result));
        assert.doesNotMatch(JSON.stringify(result), /canceled|stopped/i);
        if (blocking) assert.deepEqual([result.assignmentId, result.status], [assignmentId, 'running']);
      }
      await until(() => ended.length === 1, 'main\'s turn to end');
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.equal(agents[1].closed, false, 'the assignment keeps running');
      assert.deepEqual(runtime.status('root').assignments.map(entry => [entry.id, entry.status]), [[assignmentId, 'running']]);
      await agents[1].call('alp_handoff', peerHandoff);
      agents[1].finish('long job finished');
      await until(() => main.started.length === 2, 'the result to wake main');
      const wake = main.started.at(-1).params.input.at(-1).text;
      assert.ok(wake.includes(assignmentId));
      assert.match(wake, /result from peer[\s\S]*long job finished/);
    });
  }
});

// The other side of #116: the user's stop and a closing session do end the work, and say so.
test('the user\'s stop or closing the session cancels the assignment a wait was for, and the wait says so', async t => {
  for (const operation of ['interrupt', 'close']) for (const waiting of ['wait true', 'alp_wait']) {
    await t.test(`${operation}, ${waiting}`, async t => {
      const { runtime, agents, main } = await tree(t, { options: () => ({ checkInMs: 0, silentForMs: 3_600_000 }) });
      const delegated = main.call('alp_delegate', { agent: 'peer', task: 'Long job', mode: 'read-only', ...(waiting === 'wait true' ? { wait: true } : {}) });
      await until(() => agents[1]?.started.length, 'the peer to start');
      const pending = waiting === 'wait true' ? delegated : (await delegated, main.call('alp_wait', { timeoutMs: 3_000_000 }));
      await new Promise(resolve => setTimeout(resolve, 30));
      await runtime[operation]('root');
      const result = await pending;
      if (waiting === 'wait true') assert.deepEqual([result.status, result.error], ['canceled', 'Parent assignment stopped']);
      else assert.deepEqual([result.error, result.running], ['Turn ended', undefined]);
      await until(() => agents[1].closed, 'the assignment to be closed');
    });
  }
});

// #116: main asking the user is a deliberate wait for an answer, but a message the user writes in
// the chat instead must not queue behind it for the question's 30 minutes.
test('the user writing instead of answering ends main\'s question at once', async t => {
  const { runtime, main } = await tree(t, { options: () => ({ checkInMs: 0 }) });
  const asked = main.call('alp_ask', { question: 'SQLite or Postgres?', options: ['SQLite', 'Postgres'] });
  await until(() => runtime.questions().length === 1, 'the question to reach the user');
  await steer(runtime, 'Sao rồi e');
  const released = await Promise.race([asked, new Promise(resolve => setTimeout(() => resolve({ status: 'still waiting' }), 200))]);
  assert.deepEqual([released.status, released.userMessage], ['user_wrote', true], JSON.stringify(released));
  assert.match(released.next, /Answer them first/);
  assert.equal(runtime.questions().length, 0, 'the question leaves the user\'s screen');
  assert.deepEqual(main.calls.filter(call => call.method === 'turn/steer').map(call => call.params.input.at(-1).text), ['Sao rồi e']);
  // An answer to the question still works as before.
  const again = main.call('alp_ask', { question: 'Which port?' });
  await until(() => runtime.questions().length === 1, 'the second question');
  runtime.answer(runtime.questions()[0].id, { text: '8080' });
  assert.deepEqual([(await again).status, (await again).answer], ['answered', '8080']);
});
