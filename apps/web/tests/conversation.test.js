// Conversation fork and rewind (docs/protocol/alp-json-rpc-v1.md §12.7) in the web app: when the
// controls show, how refusals read and whether a request id may go again, which user messages map
// to which turns, and the controller against an in-memory host: a rewind reloads the timeline under
// the new generation (after its own request and after another client's), a fork opens the new root,
// a restored branch sees the turns the rewind set aside.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AlpClientError, AlpRpcError } from '@anhlp/alp-client/portable';
import { Controller } from '../src/lib/controller.js';
import { allTurnsEnded, branchTurns, conversationGate, conversationMarker, describeConversationError, turnsByMessage } from '../src/lib/conversation.js';
import { emptyProjection, entriesOf, project, prependHistory } from '../src/lib/timeline.js';
import { FakeHost, until } from './support/fake-host.js';

const CAPS = ['session.history', 'session.fork', 'session.rewind'];

// ---- gating -------------------------------------------------------------------------------

test('controls show only with the capability, the summary saying so, the token and a generation', () => {
  const base = { capabilities: CAPS, canRead: true, canWrite: true, summary: { conversation: { fork: true, rewind: true } }, generation: 'g1' };
  assert.deepEqual(conversationGate(base), { fork: { shown: true }, rewind: { shown: true } });
  // Without the capability: hidden, nothing said.
  assert.deepEqual(conversationGate({ ...base, capabilities: ['session.history'] }), { fork: { shown: false }, rewind: { shown: false } });
  // The summary absent or false: hidden, with the host's reason in words.
  assert.equal(conversationGate({ ...base, summary: {} }).fork.shown, false);
  const unsupported = conversationGate({ ...base, summary: { conversation: { fork: false, rewind: false, reason: 'runtime_unsupported' } } });
  assert.equal(unsupported.rewind.shown, false);
  assert.match(unsupported.rewind.reason, /runtime that cannot fork or rewind/);
  assert.equal(conversationGate({ ...base, summary: { conversation: { fork: true, rewind: false } } }).rewind.shown, false);
  // A viewer token: neither; a write token without read (hand-edited): no fork.
  assert.equal(conversationGate({ ...base, canWrite: false }).rewind.shown, false);
  assert.equal(conversationGate({ ...base, canRead: false }).fork.shown, false);
  assert.equal(conversationGate({ ...base, canRead: false }).rewind.shown, true);
  // No history generation (no session.history, or not loaded yet): neither.
  assert.equal(conversationGate({ ...base, generation: null }).fork.shown, false);
  assert.equal(conversationGate({ ...base, capabilities: ['session.fork', 'session.rewind'] }).rewind.shown, false);
  // Busy: rewind is shown disabled with a reason; a fork through an ended turn may go on.
  const busy = conversationGate({ ...base, busy: true });
  assert.deepEqual(busy.rewind, { shown: true, reason: 'Wait until main and its agents are idle.' });
  assert.deepEqual(busy.fork, { shown: true });
  assert.equal(conversationGate({ ...base, online: false }).fork.reason, 'Reconnecting…');
});

// ---- errors -------------------------------------------------------------------------------

test('refusals read as words; only a lost answer keeps the request id', () => {
  const rpc = (code, reason, message = reason) => new AlpRpcError({ code, message, data: { reason } });
  const busy = describeConversationError(rpc(1004, 'session_busy'));
  assert.match(busy.message, /still working/);
  assert.equal(busy.retrySame, false);
  const stale = describeConversationError(rpc(1004, 'stale_generation'));
  assert.equal(stale.reload, true);
  assert.equal(describeConversationError(rpc(1001, 'turn_not_found')).reload, true);
  assert.match(describeConversationError(rpc(1005, 'empty_prefix')).message, /Start a new session/);
  assert.match(describeConversationError(rpc(1005, 'boundary_unmapped')).message, /cannot go back to exactly this point/);
  const native = describeConversationError(rpc(1005, 'native_refused', 'Codex refused the fork: nope'));
  // The gateway's fixed sentence is not appended to the same statement again.
  assert.equal(native.message, "The agent's runtime refused it. Nothing changed.");
  // outcome_unknown: never the same id again.
  const unknown = describeConversationError(rpc(1004, 'outcome_unknown'));
  assert.equal(unknown.retrySame, false);
  assert.match(unknown.message, /new attempt is a new request/);
  // A lost answer: the same id, which the host answers once.
  const timeout = describeConversationError(rpc(1000, 'gateway_timeout'));
  assert.equal(timeout.retrySame, true);
  assert.match(timeout.message, /same request/);
  assert.equal(describeConversationError(new AlpClientError('closed', 'connection closed')).retrySame, true);
  assert.equal(describeConversationError(rpc(1000, 'persistence_failed')).retrySame, true);
  assert.match(describeConversationError(new AlpRpcError({ code: 1003, message: 'no', data: { reason: 'grant', permission: 'session.write' } })).message, /needs session\.write/);
  assert.equal(describeConversationError(rpc(1004, 'key_conflict')).retrySame, false);
});

// ---- turns --------------------------------------------------------------------------------

/** A root timeline: user messages, their prompt.accepted, turn start/end, replies. */
function timeline(root, turns, { steerInto } = {}) {
  let projection = emptyProjection(root);
  let cursor = 0;
  const add = event => { projection = project(projection, { sessionId: root, epoch: 'e', seq: ++cursor, cursor, ts: '', event }); };
  turns.forEach((text, index) => {
    const turnId = `turn-${index + 1}`;
    add({ type: 'item', item: { kind: 'user_message', id: `u${index}`, text, clientMessageId: `m${index}` } });
    add({ type: 'prompt.accepted', clientMessageId: `m${index}`, result: 'turn', turnId });
    add({ type: 'turn.started', turnId, origin: 'user' });
    if (steerInto === index) {
      add({ type: 'item', item: { kind: 'user_message', id: 'us', text: 'steer', clientMessageId: 'ms' } });
      add({ type: 'prompt.accepted', clientMessageId: 'ms', result: 'steer', turnId });
    }
    add({ type: 'item', item: { kind: 'assistant_message', id: `a${index}`, text: `echo ${text}` } });
    add({ type: 'turn.ended', turnId, state: 'completed' });
  });
  return projection;
}

test('user messages map to their turns: not the first, steers never, later turns counted', () => {
  const projection = timeline('r', ['one', 'two', 'three'], { steerInto: 1 });
  assert.deepEqual(projection.turnOrder, ['turn-1', 'turn-2', 'turn-3']);
  const turns = turnsByMessage(projection);
  assert.deepEqual([...turns.keys()], ['r:u0', 'r:u1', 'r:u2'], 'the steer started no turn');
  assert.deepEqual(turns.get('r:u0'), { turnId: 'turn-1', index: 0, later: 3, rewindable: false, ended: true, text: 'one' });
  assert.equal(turns.get('r:u1').rewindable, true);
  assert.equal(turns.get('r:u2').later, 1);
  // With older history not loaded, the first loaded turn may not be the first.
  assert.equal(turnsByMessage(projection, { hasOlder: true }).get('r:u0').rewindable, true);
  assert.equal(allTurnsEnded(projection), true);
  // An older page brings its turns and prompt outcomes along.
  const older = [
    { sessionId: 'r', epoch: 'o', seq: 1, cursor: 1, ts: '', event: { type: 'item', item: { kind: 'user_message', id: 'u0', text: 'one', clientMessageId: 'm0' } } },
    { sessionId: 'r', epoch: 'o', seq: 2, cursor: 2, ts: '', event: { type: 'prompt.accepted', clientMessageId: 'm0', result: 'turn', turnId: 'turn-1' } },
    { sessionId: 'r', epoch: 'o', seq: 3, cursor: 3, ts: '', event: { type: 'turn.ended', turnId: 'turn-1', state: 'completed' } },
  ];
  let tail = emptyProjection('r');
  tail = project(tail, { sessionId: 'r', epoch: 't', seq: 4, cursor: 4, ts: '', event: { type: 'item', item: { kind: 'user_message', id: 'u1', text: 'two', clientMessageId: 'm1' } } });
  tail = project(tail, { sessionId: 'r', epoch: 't', seq: 5, cursor: 5, ts: '', event: { type: 'prompt.accepted', clientMessageId: 'm1', result: 'turn', turnId: 'turn-2' } });
  const merged = prependHistory(tail, older);
  assert.deepEqual(merged.turnOrder, ['turn-1', 'turn-2']);
  assert.equal(turnsByMessage(merged).get('r:u0').turnId, 'turn-1');
  assert.equal(turnsByMessage(merged).get('r:u1').rewindable, true);
});

test('conversation markers are recognised; the branch size comes from the summary or the text', () => {
  assert.deepEqual(conversationMarker({ kind: 'notice', id: 'rewind:br_1', text: '' }), { kind: 'rewind', branchId: 'br_1' });
  assert.deepEqual(conversationMarker({ kind: 'notice', id: 'fork:ses_2' }), { kind: 'fork', sessionId: 'ses_2' });
  assert.equal(conversationMarker({ kind: 'notice', id: 'oversized:3' }), null);
  assert.equal(conversationMarker({ kind: 'assistant_message', id: 'rewind:x' }), null);
  assert.equal(branchTurns({ text: '' }, [{ branchId: 'br_1', turns: 4 }], 'br_1'), 4);
  assert.equal(branchTurns({ text: 'moved: 2 later turns to a branch' }, [], 'br_1'), 2);
});

// ---- the controller against a host --------------------------------------------------------

function setup(t) {
  const host = new FakeHost();
  host.capabilities.push(...CAPS);
  const make = () => {
    const controller = new Controller({ open: host.open, backoff: { initialMs: 5, maxMs: 20, jitter: 0 }, stableMs: 1, taskPollMs: 60_000, sessionPollMs: 60_000, requestTimeoutMs: 2_000, releaseTimeoutMs: 500 });
    t.after(() => controller.disconnect());
    return controller;
  };
  return { host, make };
}

async function open(controller, root) {
  controller.connect({ url: 'http://127.0.0.1:7434', token: 'alpgw1.0123456789abcdef.secret' });
  await until(() => controller.getState().connection.phase === 'open', 'open');
  controller.selectWorkspace('/w/a');
  await until(() => controller.getState().sessions.status === 'ready', 'sessions');
  controller.selectSession(root);
  await until(() => controller.getState().tree?.status === 'attached', 'attached');
}

const texts = controller => entriesOf(controller.getState().tree.projection, controller.getState().tree.rootId).map(entry => entry.item.text);

async function say(controller, text) {
  await controller.sendPrompt(text);
  await until(() => texts(controller).includes(`echo: ${text}`), `reply to ${text}`);
}

test('a rewind sends the held generation, then the view reloads the new history under the same id', async t => {
  const { host, make } = setup(t);
  host.seed('ses_a', { title: 'Codes' });
  host.root('ses_a').summary.conversation = { fork: true, rewind: true };
  const controller = make();
  await open(controller, 'ses_a');
  await say(controller, 'codeword ALPHA');
  await say(controller, 'codeword BRAVO');
  await say(controller, 'codeword CHARLIE');
  const gate = controller.conversationGate();
  assert.deepEqual(gate, { fork: { shown: true }, rewind: { shown: true } });
  const turns = turnsByMessage(controller.getState().tree.projection);
  const bravo = [...turns.values()].find(turn => turn.text === 'codeword BRAVO');
  assert.equal(bravo.later, 2);
  const historyReads = host.count('session.history');

  const result = await controller.rewindConversation({ beforeTurnId: bravo.turnId, requestId: 'r1' });
  assert.equal(result.generation, 'gen-ses_a-2');
  const sent = host.calls.find(call => call.method === 'session.rewind').params;
  assert.deepEqual(sent, { sessionId: 'ses_a', requestId: 'r1', ifGeneration: 'gen-ses_a-1', beforeTurnId: bravo.turnId });
  await until(() => controller.historyGeneration('ses_a') === 'gen-ses_a-2' && controller.getState().tree.status === 'attached', 'reloaded');
  await until(() => !texts(controller).includes('codeword BRAVO'), 'the later turns are gone');
  assert.deepEqual(texts(controller).filter(text => /ALPHA|BRAVO|CHARLIE/.test(text)), ['codeword ALPHA', 'echo: codeword ALPHA']);
  assert.match(texts(controller).at(-1), /Files were not changed/);
  assert.equal(controller.getState().selected, 'ses_a', 'the same session');
  // One reload for the answer and the live history.reset together.
  assert.equal(host.count('session.history') - historyReads, 1);
  const attach = host.calls.filter(call => call.method === 'session.attach').at(-1).params;
  assert.equal(attach.generation, 'gen-ses_a-2');
  assert.deepEqual(controller.rootSummary().branches?.map(branch => branch.turns), [2]);
  // The same request again (a lost answer) is the first result, not a second rewind.
  const again = await controller.rewindConversation({ beforeTurnId: bravo.turnId, requestId: 'r1' });
  assert.equal(again.duplicate, true);
  assert.equal(again.branch.branchId, result.branch.branchId);
});

test('another client\'s rewind resets this view: its history.reset drops the cache and reloads', async t => {
  const { host, make } = setup(t);
  host.seed('ses_a');
  host.root('ses_a').summary.conversation = { fork: true, rewind: true };
  const watcher = make();
  await open(watcher, 'ses_a');
  await say(watcher, 'one');
  await say(watcher, 'two');
  const other = make();
  await open(other, 'ses_a');
  const turn = [...turnsByMessage(other.getState().tree.projection).values()].find(entry => entry.text === 'two');
  await other.rewindConversation({ beforeTurnId: turn.turnId, requestId: 'elsewhere' });
  await until(() => watcher.historyGeneration('ses_a') === 'gen-ses_a-2', 'the watcher reloaded');
  await until(() => !texts(watcher).includes('two'), 'the watcher no longer shows the cut turn');
  assert.ok(texts(watcher).includes('one'));
  // It continues on the new generation: a new message reaches it.
  await say(watcher, 'three');
  assert.ok(texts(watcher).includes('echo: three'));
});

test('a stale generation is refused, explained, and the view reloads; a busy root is refused', async t => {
  const { host, make } = setup(t);
  host.seed('ses_a');
  host.root('ses_a').summary.conversation = { fork: true, rewind: true };
  const controller = make();
  await open(controller, 'ses_a');
  await say(controller, 'one');
  await say(controller, 'two');
  const turn = [...turnsByMessage(controller.getState().tree.projection).values()].find(entry => entry.text === 'two');
  // The host moved on without this view knowing (no event reached it).
  host.root('ses_a').generation = 'gen-elsewhere';
  const reads = host.count('session.history');
  await assert.rejects(controller.rewindConversation({ beforeTurnId: turn.turnId, requestId: 'x1' }), error => describeConversationError(error).reason === 'stale_generation');
  await until(() => controller.historyGeneration('ses_a') === 'gen-elsewhere', 'reloaded after the refusal');
  assert.equal(host.count('session.history'), reads + 1);
  await controller.sendPrompt('hold [hold]');
  await until(() => 'ses_a' in controller.getState().tree.projection.running, 'running');
  assert.equal(controller.conversationGate().rewind.reason, 'Wait until main and its agents are idle.');
  await assert.rejects(controller.rewindConversation({ beforeTurnId: turn.turnId, requestId: 'x2' }), error => /still working/.test(describeConversationError(error).message));
});

test('a fork opens the new root with the conversation through its turn; a branch restores as a new session', async t => {
  const { host, make } = setup(t);
  host.seed('ses_a', { title: 'Codes' });
  host.root('ses_a').summary.conversation = { fork: true, rewind: true };
  const controller = make();
  await open(controller, 'ses_a');
  await say(controller, 'codeword ALPHA');
  await say(controller, 'codeword BRAVO');
  const [alpha, bravo] = [...turnsByMessage(controller.getState().tree.projection).values()];
  const fork = await controller.forkConversation({ requestId: 'f1', boundary: { throughTurnId: alpha.turnId }, title: 'Codes (fork)' });
  const forkId = fork.session.id;
  assert.equal(host.calls.find(call => call.method === 'session.fork').params.ifGeneration, 'gen-ses_a-1');
  await until(() => controller.getState().selected === forkId && controller.getState().tree?.status === 'attached', 'the fork is open');
  assert.ok(controller.getState().sessions.list.some(row => row.id === forkId), 'listed at once');
  assert.deepEqual(texts(controller).filter(text => /ALPHA|BRAVO/.test(text)), ['codeword ALPHA', 'echo: codeword ALPHA']);
  assert.equal(controller.rootSummary().forkedFrom.sessionId, 'ses_a');

  // Back to the source: rewind before BRAVO, then restore that branch.
  controller.selectSession('ses_a');
  await until(() => controller.getState().tree?.rootId === 'ses_a' && controller.getState().tree.status === 'attached', 'source again');
  const rewound = await controller.rewindConversation({ beforeTurnId: bravo.turnId, requestId: 'r1' });
  await until(() => controller.historyGeneration('ses_a') === 'gen-ses_a-2', 'reloaded');
  const restored = await controller.forkConversation({ requestId: 'f2', branchId: rewound.branch.branchId, title: 'Codes (restored)' });
  await until(() => controller.getState().selected === restored.session.id && controller.getState().tree?.status === 'attached', 'the restored session is open');
  assert.deepEqual(texts(controller).filter(text => /ALPHA|BRAVO/.test(text)), ['codeword ALPHA', 'echo: codeword ALPHA', 'codeword BRAVO', 'echo: codeword BRAVO']);
  assert.equal(host.calls.filter(call => call.method === 'session.fork').at(-1).params.ifGeneration, 'gen-ses_a-2', 'the root\'s current generation');
});

test('without the capability the controller offers nothing and the summary alone is not enough', async t => {
  const host = new FakeHost();
  host.capabilities.push('session.history');
  host.seed('ses_a');
  host.root('ses_a').summary.conversation = { fork: true, rewind: true };
  const controller = new Controller({ open: host.open, backoff: { initialMs: 5, maxMs: 20, jitter: 0 }, stableMs: 1, taskPollMs: 60_000, sessionPollMs: 60_000, requestTimeoutMs: 2_000 });
  t.after(() => controller.disconnect());
  await open(controller, 'ses_a');
  assert.deepEqual(controller.conversationGate(), { fork: { shown: false }, rewind: { shown: false } });
});

test('a token limited to modes is not offered fork or rewind of a tree it may not drive', () => {
  const gate = conversationGate({ capabilities: ['session.fork', 'session.rewind', 'session.history'], canRead: true, canWrite: true, summary: { conversation: { fork: true, rewind: true } }, generation: 'g', driveBlock: 'Your access token can only drive sessions in read-only mode; this conversation runs in full-access.' });
  assert.equal(gate.fork.shown, false);
  assert.equal(gate.rewind.shown, false);
  assert.match(gate.rewind.reason, /read-only mode/);
});

test('a fork into a worktree reuses the worktree it made for that destination after a refused fork; another destination makes its own', async t => {
  const { host, make } = setup(t);
  host.capabilities.push('workspace.registry', 'workspace.worktree');
  host.principal.permissions.push('workspace.manage');
  host.seed('ses_a', { title: 'Codes' });
  host.root('ses_a').summary.conversation = { fork: true, rewind: true };
  host.intercept.set('workspace.list', (_params, _connection, { answer }) => { answer({ workspaces: [{ id: 'wks_a', projectId: 'prj', directory: '/w/a', canonical: '/w/a', labels: [], createdAt: 'x', revision: 1 }], revision: 1, total: 1, nextCursor: null }); return 'handled'; });
  const created = [];
  host.intercept.set('workspace.worktree.create', (params, _connection, { answer }) => {
    created.push(params);
    answer({ workspace: { id: `wks_${params.mappingId}_${created.length}`, projectId: 'prj', directory: `/w/${params.mappingId}-${created.length}`, labels: [], createdAt: 'x', revision: 2 }, revision: 2 });
    return 'handled';
  });
  let refusals = 1;
  host.intercept.set('session.fork', (_params, _connection, { fail }) => {
    if (refusals-- > 0) { fail(1004, 'busy', { reason: 'session_busy' }); return 'handled'; }
    return undefined;
  });
  const controller = make();
  await open(controller, 'ses_a');
  await controller.refreshRegistry();
  await until(() => controller.worktreeForkSource()?.id === 'wks_a', 'the registry');
  await say(controller, 'codeword ALPHA');
  const [alpha] = [...turnsByMessage(controller.getState().tree.projection).values()];
  // Refused after its worktree was made; the retry (a new fork request id) forks into the same worktree.
  assert.equal(controller.worktreeForkSource()?.id, 'wks_a');
  await assert.rejects(controller.forkIntoWorktree({ requestId: 'f1', worktreeKey: 'dialog:m1', mappingId: 'm1', boundary: { throughTurnId: alpha.turnId } }), error => error?.data?.reason === 'session_busy');
  assert.equal(controller.worktreeForkSource()?.id, 'wks_a');
  const fork = await controller.forkIntoWorktree({ requestId: 'f2', worktreeKey: 'dialog:m1', mappingId: 'm1', boundary: { throughTurnId: alpha.turnId } });
  assert.equal(created.length, 1);
  assert.equal(host.calls.filter(call => call.method === 'session.fork').at(-1).params.workspaceId, 'wks_m1_1');
  assert.ok(fork.session.id);
  // The fork opened in its worktree; back in the source's workspace, another destination is its own worktree.
  controller.selectWorkspace('/w/a');
  await until(() => controller.worktreeForkSource()?.id === 'wks_a', 'the source workspace again');
  controller.selectSession('ses_a');
  await until(() => controller.getState().tree?.rootId === 'ses_a' && controller.getState().tree.status === 'attached', 'the source again');
  await controller.forkIntoWorktree({ requestId: 'f3', worktreeKey: 'dialog:m2', mappingId: 'm2', boundary: { throughTurnId: alpha.turnId } });
  assert.equal(created.length, 2);
  assert.equal(created[1].mappingId, 'm2');
});
