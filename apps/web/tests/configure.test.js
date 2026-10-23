// A live root's model, thinking and team (docs/protocol/alp-json-rpc-v1.md §12.9, issue #121 D) in the
// web app: when the controls are offered and why not, how refusals read, which models a session may
// switch to, and the controller against an in-memory host: one change at a time with a fresh requestId
// and the held generation, labels from what the host answered (never the choice), refusals that change
// nothing, a lost answer sent again with the same requestId, and a mismatch that points to a new session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AlpClientError, AlpRpcError } from '@anhlp/alp-client/portable';
import { Controller } from '../src/lib/controller.js';
import { CONFIGURE_MESSAGES, configuredNotice, configuredSummary, describeConfigureError, liveConfigureGate, liveModels } from '../src/lib/configure.js';
import { effortLabel } from '../src/lib/new-session.js';
import { FakeHost, until } from './support/fake-host.js';

const CAPS = ['session.history', 'session.configure.live'];
const rpc = (code, reason, data = {}) => new AlpRpcError({ code, message: `host text for ${reason}: /secret/path`, data: { reason, ...data } });

// ---- gating -------------------------------------------------------------------------------

test('controls are offered with the capability and the summary; disabled with a reason otherwise', () => {
  const base = { capabilities: CAPS, canWrite: true, canTeam: true, summary: { conversation: { fork: true, rewind: true, configure: true } }, generation: 'g1' };
  assert.deepEqual(liveConfigureGate(base), { shown: true, model: { enabled: true }, thinking: { enabled: true }, team: { enabled: true } });
  // An older host: read-only labels, with why.
  const old = liveConfigureGate({ ...base, capabilities: ['session.history'] });
  assert.equal(old.shown, false);
  assert.match(old.reason, /cannot change it on a running session/);
  const reason = (input, key = 'model') => liveConfigureGate({ ...base, ...input })[key];
  assert.deepEqual(reason({ summary: { conversation: { fork: false, rewind: false, configure: false, reason: 'runtime_unsupported' } } }), { enabled: false, reason: CONFIGURE_MESSAGES.runtime_unsupported });
  assert.equal(reason({ summary: { conversation: { fork: true, rewind: true } } }).enabled, false, 'a summary that does not say configure');
  assert.equal(reason({ summary: { conversation: { configure: false, reason: 'not_persistent' } } }).reason, CONFIGURE_MESSAGES.not_persistent);
  assert.match(reason({ canWrite: false }).reason, /session\.write/);
  assert.match(reason({ canWrite: false }, 'team').reason, /session\.write/);
  // session.team.write gates the team only.
  assert.deepEqual(reason({ canTeam: false }), { enabled: true });
  assert.match(reason({ canTeam: false }, 'team').reason, /session\.team\.write/);
  assert.equal(reason({ driveBlock: 'Your access token can only drive sessions in read-only mode.' }).reason, 'Your access token can only drive sessions in read-only mode.');
  assert.equal(reason({ closed: true }).reason, CONFIGURE_MESSAGES.session_closed);
  assert.match(reason({ generation: null }).reason, /still loading/);
  assert.equal(reason({ online: false }).reason, 'Reconnecting…');
  assert.match(reason({ busy: true }).reason, /idle/);
  assert.match(reason({ busy: true }, 'thinking').reason, /idle/);
  assert.match(reason({ configuring: true }, 'team').reason, /Applying/);
});

test('only the session\'s runtime\'s models are offered; the current one is found by its prefixed id', () => {
  const models = [{ id: 'codex:gpt-5.6-sol', label: 'GPT', efforts: ['low'] }, { id: 'codex:m', label: 'M', efforts: [] }, { id: 'claude:claude-haiku-4-5', label: 'Haiku', efforts: [] }];
  const { same, current, others } = liveModels(models, { runtime: 'codex', model: 'gpt-5.6-sol' });
  assert.deepEqual(same.map(row => row.id), ['codex:gpt-5.6-sol', 'codex:m']);
  assert.equal(current?.label, 'GPT');
  assert.equal(others, 1);
  assert.deepEqual(liveModels(models, { model: 'x' }).same, [], 'no runtime known: nothing offered');
});

test('refusals read as fixed words; a mismatch says to start a new session; host text never shows', () => {
  for (const [code, reason] of [[1004, 'session_busy'], [1005, 'native_refused'], [1001, 'team_not_found'], [-32602, 'invalid_params'], [1003, 'permission_escalation'], [1004, 'stale_generation']]) {
    const described = describeConfigureError(rpc(code, reason));
    assert.equal(described.message, CONFIGURE_MESSAGES[reason], reason);
    assert.doesNotMatch(described.message, /secret/);
  }
  assert.equal(describeConfigureError(rpc(1005, 'runtime_mismatch', { action: 'session.create' })).newSession, true);
  assert.equal(describeConfigureError(rpc(1005, 'agent_mismatch', { action: 'session.create' })).newSession, true);
  assert.equal(describeConfigureError(rpc(1004, 'session_busy')).newSession, false);
  assert.equal(describeConfigureError(rpc(1004, 'stale_generation')).reload, true);
  assert.match(describeConfigureError(rpc(1003, 'grant', { permission: 'session.team.write' })).message, /needs session\.team\.write/);
  // A lost answer: the same id may go again; outcome_unknown never.
  assert.equal(describeConfigureError(new AlpClientError('closed', 'connection closed', { sent: 'maybe' })).retrySame, true);
  assert.equal(describeConfigureError(rpc(1004, 'outcome_unknown')).retrySame, false);
});

test('the answer\'s effective configuration is what the labels show', () => {
  const effective = { team: 'cafe', teamLabel: 'Cafe', agent: 'main', runtime: 'codex', model: 'm2', thinking: 'high', mode: 'full-access', supervisor: true, maxPeers: 3, delegates: [], tools: [], mcpServers: [], hooks: 0 };
  const summary = configuredSummary({ id: 's', model: 'm', thinking: 'low', teamLabel: 'Phở', workflow: { mode: 'pho', maxPeers: 2, supervisor: false } }, effective);
  assert.deepEqual([summary.model, summary.thinking, summary.teamLabel, summary.workflow], ['m2', 'high', 'Cafe', { mode: 'cafe', maxPeers: 3, supervisor: true }]);
  assert.equal(configuredSummary({ id: 's', teamLabel: 'Phở' }, { ...effective, team: 'custom', teamLabel: undefined }).teamLabel, 'Phở', 'the host\'s own summary label stays when the answer has none');
  assert.equal(configuredNotice({ status: 'applied', effective, restarted: true }, effortLabel, 'M2'), 'Changed: Cafe · main runs M2 · High. The agent restarted on the same conversation.');
  assert.match(configuredNotice({ status: 'unchanged', effective, restarted: false }, effortLabel), /^Nothing to change/);
});

// ---- the controller against a host --------------------------------------------------------

function setup(t, principal) {
  const host = new FakeHost(principal ? { principal } : {});
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
  await until(() => controller.getState().sessions.status === 'ready' && controller.getState().catalog.status === 'ready', 'sessions and catalog');
  controller.selectSession(root);
  await until(() => controller.getState().tree?.status === 'attached' && !!controller.historyGeneration(root), 'attached');
}

const shown = controller => { const tree = controller.getState().tree; const session = tree.projection.sessions[tree.rootId]; return { model: session.model, thinking: session.thinking, team: session.workflow?.mode, teamLabel: session.teamLabel }; };
const TEAM_WRITER = { id: 'p1', label: 'tests', permissions: ['session.read', 'session.write', 'project.read', 'project.write', 'session.team.write'], workspaces: ['/w/a'], workspaceRoots: [{ path: '/w/a', canonical: '/w/a' }] };

test('a model change sends a fresh requestId and the held generation; the labels follow the host\'s answer', async t => {
  const { host, make } = setup(t);
  host.seed('ses_a', { title: 'Live' });
  host.root('ses_a').summary.conversation = { fork: true, rewind: true, configure: true };
  const controller = make();
  await open(controller, 'ses_a');
  assert.equal(controller.liveConfigure().model.enabled, true);
  assert.deepEqual(shown(controller), { model: 'm', thinking: 'low', team: 'pho', teamLabel: undefined });
  const pending = controller.configureLive({ model: 'codex:gpt-5.6-sol' });
  // One change at a time: a second while the first is on its way sends nothing.
  assert.equal(await controller.configureLive({ thinking: 'high' }), undefined);
  const result = await pending;
  assert.equal(result.configured.status, 'applied');
  const sent = host.calls.filter(call => call.method === 'session.configure');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].params.sessionId, 'ses_a');
  assert.equal(sent[0].params.model, 'codex:gpt-5.6-sol');
  assert.equal(sent[0].params.ifGeneration, 'gen-ses_a-1');
  assert.match(sent[0].params.requestId, /^web-conv-[0-9a-f]{16}$/);
  // The model the host took; the effort it kept (low is one of the new model's).
  assert.deepEqual(shown(controller), { model: 'gpt-5.6-sol', thinking: 'low', team: 'pho', teamLabel: 'Phở' });
  assert.match(controller.getState().notice.text, /^Changed: Phở · main runs GPT · Low\./);
  assert.equal(controller.getState().busy.configure, false);
  // Thinking next: another requestId.
  await controller.configureLive({ thinking: 'high' });
  const second = host.calls.filter(call => call.method === 'session.configure')[1].params;
  assert.equal(second.thinking, 'high');
  assert.notEqual(second.requestId, sent[0].params.requestId);
  assert.equal(shown(controller).thinking, 'high');
  // The session list row follows too.
  assert.equal(controller.getState().sessions.list.find(row => row.id === 'ses_a').model, 'gpt-5.6-sol');
});

test('refusals change nothing shown and say why; a mismatch offers a new session; host text never shows', async t => {
  const { host, make } = setup(t, TEAM_WRITER);
  host.seed('ses_a', { title: 'Live' });
  host.root('ses_a').summary.conversation = { fork: true, rewind: true, configure: true };
  const controller = make();
  await open(controller, 'ses_a');
  const before = shown(controller);
  // Another runtime's model: refused by the host, a notice pointing to a new session.
  await controller.configureLive({ model: 'claude:claude-haiku-4-5' });
  assert.deepEqual(shown(controller), before);
  assert.deepEqual(controller.getState().notice, { id: controller.getState().notice.id, level: 'error', text: CONFIGURE_MESSAGES.runtime_mismatch, action: 'new-session' });
  // A team with another main agent: the preview refuses it first; nothing is sent to configure.
  const configures = host.count('session.configure');
  await controller.configureLive({ team: 'solo' });
  assert.equal(host.count('session.configure.preview'), 1);
  assert.equal(host.count('session.configure'), configures);
  assert.equal(controller.getState().notice.text, CONFIGURE_MESSAGES.agent_mismatch);
  assert.equal(controller.getState().notice.action, 'new-session');
  // The host refusing after the preview (it got busy meanwhile): the fixed words, nothing changes.
  host.configureError = rpc(1004, 'session_busy');
  await controller.configureLive({ team: 'cafe' });
  assert.equal(controller.getState().notice.text, CONFIGURE_MESSAGES.session_busy);
  assert.equal(controller.getState().notice.action, undefined);
  assert.deepEqual(shown(controller), before);
  host.configureError = undefined;
  // Then the team changes: label from the answer.
  await controller.configureLive({ team: 'cafe' });
  assert.deepEqual(shown(controller), { ...before, team: 'cafe', teamLabel: 'Cafe' });
  assert.doesNotMatch(JSON.stringify(controller.getState().notice), /secret/);
});

test('a busy tree disables the controls and a change is not sent; a stale generation reloads the view', async t => {
  const { host, make } = setup(t);
  host.seed('ses_a', { title: 'Live' });
  host.root('ses_a').summary.conversation = { fork: true, rewind: true, configure: true };
  const controller = make();
  await open(controller, 'ses_a');
  host.startTurn('ses_a');
  await until(() => controller.liveConfigure().model.enabled === false, 'disabled while working');
  assert.match(controller.liveConfigure().model.reason, /idle/);
  await controller.configureLive({ model: 'codex:gpt-5.6-sol' });
  assert.equal(host.count('session.configure'), 0);
  assert.match(controller.getState().notice.text, /idle/);
  host.endTurn('ses_a');
  await until(() => controller.liveConfigure().model.enabled, 'enabled once idle');
  // Another client rewound meanwhile: the held generation is stale.
  host.root('ses_a').generation = 'gen-elsewhere';
  await controller.configureLive({ thinking: 'high' });
  assert.equal(controller.getState().notice.text, CONFIGURE_MESSAGES.stale_generation);
  assert.equal(shown(controller).thinking, 'low');
  await until(() => controller.historyGeneration('ses_a') === 'gen-elsewhere', 'reloaded after the refusal');
});

test('a lost answer sends the same requestId again for the same change; the host answers it once', async t => {
  const { host, make } = setup(t);
  host.seed('ses_a', { title: 'Live' });
  host.root('ses_a').summary.conversation = { fork: true, rewind: true, configure: true };
  const controller = make();
  await open(controller, 'ses_a');
  // Another viewer keeps the root open; the host takes the change, then this connection drops before its answer arrives.
  const watcher = make();
  await open(watcher, 'ses_a');
  host.loseAnswer.add('session.configure');
  assert.equal(await controller.configureLive({ model: 'codex:gpt-5.6-sol' }), undefined);
  const notice = controller.getState().notice;
  assert.equal(notice.level, 'error');
  assert.match(notice.text, /same request/);
  assert.equal(host.configures, 1);
  await until(() => controller.getState().connection.phase === 'open' && controller.getState().tree?.status === 'attached' && controller.liveConfigure().model.enabled, 'back');
  const first = host.calls.find(call => call.method === 'session.configure').params.requestId;
  // The same change again: the same id, answered once (duplicate), the labels from that answer.
  const result = await controller.configureLive({ model: 'codex:gpt-5.6-sol' });
  assert.equal(result?.duplicate, true, JSON.stringify(controller.getState().notice));
  assert.equal(host.calls.filter(call => call.method === 'session.configure').at(-1).params.requestId, first);
  assert.equal(host.configures, 1);
  assert.equal(shown(controller).model, 'gpt-5.6-sol');
  // Another change takes a new id.
  await controller.configureLive({ thinking: 'high' });
  assert.notEqual(host.calls.filter(call => call.method === 'session.configure').at(-1).params.requestId, first);
});

test('without session.team.write the team menu is disabled and nothing is asked; model stays possible', async t => {
  const { host, make } = setup(t);
  host.seed('ses_a', { title: 'Live' });
  host.root('ses_a').summary.conversation = { fork: true, rewind: true, configure: true };
  const controller = make();
  await open(controller, 'ses_a');
  const gate = controller.liveConfigure();
  assert.equal(gate.team.enabled, false);
  assert.match(gate.team.reason, /session\.team\.write/);
  assert.equal(gate.model.enabled, true);
  await controller.configureLive({ team: 'cafe' });
  assert.equal(host.count('session.configure') + host.count('session.configure.preview'), 0);
  // A host without the capability: read-only labels.
  host.capabilities.splice(host.capabilities.indexOf('session.configure.live'), 1);
  const plain = make();
  await open(plain, 'ses_a');
  assert.equal(plain.liveConfigure().shown, false);
});
