// Permission questions reach Paseo (beta-scope §6.2, T10): a profile that asks the user turns an
// agent's request into Paseo's question card, and each answer from that card (Allow once, Always
// allow, Deny, dismissing it) goes back to the right request. Always allow outlives the session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '@anhlp/alp-core/init';
import { createProvider } from '@anhlp/alp-paseo';
import { PROVIDER_CAPABILITIES, ProviderEventSchema } from '@getpaseo/plugin/server/provider';
import { fakeTransport, until } from '../../../test/support/fake-agent.js';

// The C6 profile of beta-scope §6.3, on main.
const PROFILE = { profiles: { review: { base: 'read-only', ask: ['Bash(git push *)'], beyondMode: 'ask' } }, agents: { main: 'review' } };

async function project(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-paseo-permissions-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const root = path.join(directory, 'project');
  const home = path.join(directory, 'home');
  await mkdir(home, { recursive: true });
  await initProject(root);
  const settings = path.join(root, '.alp', 'settings.json');
  await writeFile(settings, JSON.stringify({ ...JSON.parse(await readFile(settings, 'utf8')), permissions: PROFILE }));
  return { directory, root, home, settings };
}

/** Paseo's side of the plugin: a provider connection with one ALP session that has started a turn. */
async function paseo(t, { directory, root, home }, sessionId = 'paseo-root') {
  const agents = [];
  const provider = createProvider({ language: 'English', supervisor: false, transport: fakeTransport(agents), libraryDir: home, runLogDir: path.join(directory, 'runs') });
  const connection = await provider.connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES });
  let open = true;
  const close = async () => { if (open) { open = false; await connection.close(); } };
  t.after(close);
  const events = [];
  connection.onEvent(event => { ProviderEventSchema.parse(event); events.push(event); });
  await connection.send({ type: 'session.open', requestId: 'open', sessionId, history: 'skip', config: { cwd: root, env: {}, mcpServers: {}, settings: {}, persist: true, mode: 'full-access' } });
  await connection.send({ type: 'session.prompt', sessionId, prompt: { clientMessageId: 'go', delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text: 'Go' }] } } });
  await until(() => agents[0]?.started.length === 1, 'the first turn');
  const main = agents[0];
  const cards = () => events.filter(event => event.type === 'session.permission');
  /** Waits for the next question card after the `seen` cards already handled. */
  const card = async seen => { await until(() => cards().length > seen, 'a question card'); return cards()[seen].request; };
  const resolved = id => until(() => events.some(event => event.type === 'session.permission_resolved' && event.permissionId === id), `resolution of ${id}`);
  const choose = (request, label) => connection.send({ type: 'session.permission', sessionId, permissionId: request.id, response: { behavior: 'allow', updatedInput: { ...request.input, answers: { Answer: label } } } });
  const dismiss = (request, message) => connection.send({ type: 'session.permission', sessionId, permissionId: request.id, response: { behavior: 'deny', ...(message ? { message } : {}) } });
  // Codex asking to leave its sandbox, and Claude asking through canUseTool.
  const codex = (command, extra = {}) => main.serverRequest('item/commandExecution/requestApproval', { kind: 'command', threadId: main.threadId, command, ...extra });
  const claude = request => main.serverRequest('item/permission/request', request);
  return { connection, events, main, cards, card, resolved, choose, dismiss, codex, claude, close, sessionId };
}

const permissionLog = async directory => (await readFile(path.join(directory, 'runs', 'paseo-root.jsonl'), 'utf8').catch(() => ''))
  .split('\n').filter(Boolean).map(line => JSON.parse(line));

test('a permission question is a Paseo question card; Allow once, Always allow and Deny each reach the request that asked', async t => {
  const where = await project(t);
  const { main, cards, card, resolved, choose, codex, claude, sessionId } = await paseo(t, where);
  // The profile caps the mode Paseo asked for, and Codex asks before leaving its read-only sandbox.
  assert.deepEqual([main.config.sandbox, main.config.approvalPolicy], ['read-only', 'on-request']);

  // Beyond the mode: three choices on a card on the root, naming the rule Always allow would add.
  const once = codex("/bin/zsh -lc 'npm install --no-audit'", { proposedExecpolicyAmendment: ['npm', 'install'] });
  const first = await card(0);
  assert.equal(first.kind, 'question');
  assert.equal(first.title, 'main asks you');
  assert.equal(first.description, 'main wants to run `npm install --no-audit`. Its read-only mode does not allow that. Always allow adds Bash(npm install *) to profile review.');
  assert.deepEqual(first.input.questions[0].options, [{ label: 'Allow once' }, { label: 'Always allow' }, { label: 'Deny' }]);
  assert.equal(first.metadata.alpSessionId, sessionId);
  await choose(first, 'Allow once');
  assert.deepEqual(await once, { decision: 'accept' });
  await resolved(first.id);
  // Allow once leaves the profile as it was, so the same request asks again.
  assert.equal(JSON.parse(await readFile(where.settings, 'utf8')).permissions.profiles.review.allow, undefined);

  const always = codex("/bin/zsh -lc 'npm install --no-audit'", { proposedExecpolicyAmendment: ['npm', 'install'] });
  const second = await card(1);
  await choose(second, 'Always allow');
  assert.deepEqual(await always, { decision: 'accept' });
  await resolved(second.id);
  assert.deepEqual(JSON.parse(await readFile(where.settings, 'utf8')).permissions.profiles.review.allow, ['Bash(npm install *)']);
  // Covered now: no card.
  assert.deepEqual(await codex("/bin/zsh -lc 'npm install left-pad'"), { decision: 'accept' });
  assert.equal(cards().length, 2);

  // An ask rule asks each time and offers no always; Deny, chosen on the card, refuses.
  const push = codex("/bin/zsh -lc 'git push origin main'");
  const third = await card(2);
  assert.deepEqual(third.input.questions[0].options, [{ label: 'Allow once' }, { label: 'Deny' }]);
  assert.match(third.description, /Its permission profile review asks you each time\.$/);
  await choose(third, 'Deny');
  assert.deepEqual(await push, { decision: 'decline' });
  await resolved(third.id);

  // Claude's requests come the same way; its suggested rule is what Always allow adds.
  const edit = claude({ tool: 'Bash', input: { command: 'npm ci' }, reason: 'mode', rule: 'Bash(npm ci *)' });
  const fourth = await card(3);
  assert.match(fourth.description, /^main wants to use Bash: `npm ci`\..*Always allow adds Bash\(npm ci \*\) to profile review\.$/);
  await choose(fourth, 'Always allow');
  assert.deepEqual(await edit, { allow: true, always: true });
  assert.deepEqual(JSON.parse(await readFile(where.settings, 'utf8')).permissions.profiles.review.allow, ['Bash(npm install *)', 'Bash(npm ci *)']);
  const denied = claude({ tool: 'Bash', input: { command: 'git push' }, reason: 'rule' });
  await choose(await card(4), 'Deny');
  assert.deepEqual(await denied, { allow: false, message: 'The user refused it' });

  // The run log keeps what the user decided, and that ALP asked.
  await until(async () => (await permissionLog(where.directory)).filter(entry => entry.event === 'permission').length === 6, 'the permission log');
  assert.deepEqual((await permissionLog(where.directory)).filter(entry => entry.event === 'permission').map(entry => [entry.decision, entry.asked ?? false, entry.always ?? null, entry.rule ?? null]), [
    ['accept', true, null, null], ['accept', true, 'Bash(npm install *)', null], ['accept', false, null, 'allow'],
    ['decline', true, null, 'ask'], ['accept', true, 'Bash(npm ci *)', null], ['decline', true, null, 'ask'],
  ]);
});

test('closing the card, an empty answer, a stale answer and an interrupted turn all leave the request refused', async t => {
  const where = await project(t);
  const { connection, main, card, resolved, choose, dismiss, codex, claude, events, sessionId } = await paseo(t, where);

  // Closing the card (Paseo's deny) dismisses the question: not allowed, and the agent hears why.
  const closed = claude({ tool: 'Bash', input: { command: 'npm ci' }, reason: 'mode', rule: 'Bash(npm ci *)' });
  const first = await card(0);
  await dismiss(first, 'Not now');
  assert.deepEqual(await closed, { allow: false, message: 'The user did not answer (dismissed); it was not allowed' });
  await resolved(first.id);

  // Submitting no text keeps the card open; the answer after it still counts.
  const touch = codex("/bin/zsh -lc 'touch a'");
  const second = await card(1);
  await assert.rejects(choose(second, '  '), /Type an answer before submitting/);
  await choose(second, 'Allow once');
  assert.deepEqual(await touch, { decision: 'accept' });
  await resolved(second.id);
  // A card answered already (from another client, or twice) is refused by alpd and changes nothing.
  await assert.rejects(choose(second, 'Always allow'), /No question/);
  assert.equal(JSON.parse(await readFile(where.settings, 'utf8')).permissions.profiles.review.allow, undefined);

  // Stop in Paseo while a card waits: the turn ends, the card goes away and the request is refused.
  const waiting = codex("/bin/zsh -lc 'touch b'");
  const third = await card(2);
  await connection.send({ type: 'session.interrupt', requestId: 'stop', sessionId });
  await until(() => main.calls.some(call => call.method === 'turn/interrupt'), 'the interrupt');
  main.notification('turn/completed', { threadId: main.threadId, turn: { id: main.turnId, status: 'interrupted' } });
  assert.deepEqual(await waiting, { decision: 'decline' });
  await resolved(third.id);
  await assert.rejects(choose(third, 'Allow once'), /No question/);
  // The run log is written in the background.
  const answers = async () => (await permissionLog(where.directory)).filter(entry => entry.event === 'human.answer').map(entry => entry.outcome);
  await until(async () => (await answers()).length === 3, 'the answers in the run log');
  assert.deepEqual(await answers(), ['dismissed', 'answered', 'canceled']);
  assert.ok(events.some(event => event.type === 'request.completed' && event.requestId === 'stop'));
});

test('Always allow persists in the project settings: a new provider and alpd session do not ask again', async t => {
  const where = await project(t);
  const before = await paseo(t, where);
  const asked = before.codex("/bin/zsh -lc 'npm install --no-audit'", { proposedExecpolicyAmendment: ['npm', 'install'] });
  await before.choose(await before.card(0), 'Always allow');
  assert.deepEqual(await asked, { decision: 'accept' });
  await before.close();

  // Paseo restarts the plugin: a new runtime reads the profile with the rule it gained.
  const after = await paseo(t, where, 'paseo-again');
  assert.deepEqual(await after.codex("/bin/zsh -lc 'npm install left-pad'"), { decision: 'accept' });
  // The rule covers what it names, nothing more: an ask rule and other commands still ask.
  const push = after.codex("/bin/zsh -lc 'git push origin main'");
  await after.choose(await after.card(0), 'Deny');
  assert.deepEqual(await push, { decision: 'decline' });
  assert.equal(after.cards().length, 1);
});
