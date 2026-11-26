// t-a648: a tool Antigravity denies is reported with its tool, path, mode and reason, and an
// assignment whose turn ended on a denial with no answer and no handoff is "failed", with a
// machine-readable `denied` list. Two levels:
// - the transport, fed agy's stream-json frames: the shapes measured on agy 1.5.15/1.5.16 (M0: a
//   refused read reported ERROR, a refused read reported DONE with no output; T1: a refused read,
//   then a read of a missing workspace file reported DONE with no output), and the shapes ALP must
//   not misread (a DONE/no-output read with no denial; a held step on an interrupt or a crash);
// - the runtime, with scripted Codex-shaped agents (no provider runs): what the requester gets.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '@anhlp/alp-core/init';
import { createTask, getTask } from '@anhlp/alp-core/tasks';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { AntigravityTransport } from '@anhlp/alp-runtime/antigravity-transport';
import { fakeTransport, until } from '../../../test/support/fake-agent.ts';
import type { FakeAgent } from '../../../test/support/fake-agent.ts';
import { teardown } from '../../../test/support/teardown.ts';
import type { TestContext } from 'node:test';

// `any`: the transport's notifications and alp_wait's answers are JSON of every shape; the tests read their fields.
type Json = any;
type Note = { method: string, params: Json };

// The refusal text agy 1.5.15 gave in M0, verbatim.
const DENIAL = 'permission check failed for read_file "/private/etc/hosts": user denied permission for read_file(/private/etc/hosts)\nDo not attempt to circumvent this denial by rephrasing the command, using alternative tools/scripts (e.g. python, sh, curl), or accessing the same target resource. Proceed without performing this action.';
const REASON = DENIAL.split('\n')[0];

// An agy stand-in: on the first prompt line it writes FRAMES (a JSON array); `{ "exit": n }` exits
// with n, `{ "hang": true }` stops answering. It never runs a model or a real agy.
const REPLAY = `
import { createInterface } from 'node:readline';
const frames = JSON.parse(process.env.FRAMES);
const conversation = 'replay-' + process.pid;
process.stdout.write(JSON.stringify({ event: 'init', conversation_id: conversation, init: { model: 'gemini-3.8-flash-high' } }) + '\\n');
createInterface({ input: process.stdin }).once('line', () => {
  for (const frame of frames) {
    if (frame.exit !== undefined) { process.stdout.write('', () => process.exit(frame.exit)); return; }
    if (frame.hang) return;
    process.stdout.write(JSON.stringify(frame) + '\\n');
  }
});
`;

const step = (index: number, extra: object) => ({ event: 'step_update', step_update: { step_index: index, ...extra } });
const read = (file: string, state: string, extra = {}) => ({ state, step_type: 'tool', tool_name: 'read_file', tool_info: { name: 'read_file', parameters: { Path: file }, ...extra } });
const refusedRead = (index: number, file: string) => [step(index, read(file, 'ACTIVE')), step(index, read(file, 'ERROR', { error: { type: 'TOOL_ERROR', message: DENIAL } }))];
const silentRead = (index: number, file: string) => [step(index, read(file, 'ACTIVE')), step(index, read(file, 'DONE'))];
const result = (extra = {}) => ({ event: 'result', result: { status: 'SUCCESS', response: '', ...extra } });
const deniedRead = { denied_actions: [{ action: 'read_file', display_name: 'ReadFile' }] };

/** Runs one agy turn over `frames` in `mode`; returns the notifications in order, ending with turn/completed. */
async function agyTurn(t: TestContext, frames: object[], { mode = 'workspace-write', after }: { mode?: string, after?: (transport: AntigravityTransport, seen: Note[]) => Promise<void> } = {}) {
  const defer = teardown(t);
  const dir = await mkdtemp(path.join(tmpdir(), 'alp-agy-denied-unit-'));
  defer(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const workspace = path.join(dir, 'workspace');
  await initProject(workspace);
  const script = path.join(dir, 'replay.mjs');
  await writeFile(script, REPLAY);
  const env = { PATH: process.env.PATH, FRAMES: JSON.stringify(frames) };
  const transport = new AntigravityTransport(process.execPath, workspace, env, { id: 'antigravity', label: 'Antigravity', command: process.execPath, args: [script] });
  defer(() => transport.close());
  const notes: Note[] = [];
  transport.onNotification((method, params) => notes.push({ method, params }));
  transport.onFailure(() => {});
  await transport.request('thread/start', { cwd: workspace, sandbox: mode, model: 'gemini-3.8-flash-high' });
  await transport.request('turn/start', { input: [{ type: 'text', text: 'go' }] });
  if (after) await after(transport, notes);
  await until(() => notes.some(note => note.method === 'turn/completed'), 'turn/completed');
  return { notes, workspace, turn: notes.find(note => note.method === 'turn/completed')!.params.turn };
}

const toolEnds = (notes: Note[]) => notes.filter(note => note.method === 'item/completed' && note.params.item.type === 'commandExecution').map(note => note.params.item);
const said = (notes: Note[]) => notes.filter(note => note.method === 'item/completed' && note.params.item.type === 'agentMessage').map(note => note.params.item.text);

test('agy refused a read and said why (ERROR, M0): the turn names the tool, the path, the mode and agy\'s reason', async t => {
  const { notes, turn } = await agyTurn(t, [...refusedRead(3, '/etc/hosts'), result(deniedRead)]);
  assert.equal(turn.status, 'completed');
  assert.deepEqual(turn.denied, [{ tool: 'ReadFile', path: '/etc/hosts', reason: REASON }]);
  assert.equal(turn.answered, false);
  assert.equal(turn.mode, 'workspace-write');
  assert.deepEqual(said(notes), [`Antigravity denied ReadFile on /etc/hosts (${REASON}) in workspace-write mode and ended the turn.`]);
  assert.deepEqual(toolEnds(notes).map(item => item.status), ['failed']);
});

test('agy refused a read but reported it DONE with no output (M0): the step is recorded failed, and the path is marked inferred', async t => {
  const { notes, turn } = await agyTurn(t, [...silentRead(3, '/etc/hosts'), result(deniedRead)]);
  assert.equal(turn.denied.length, 1);
  assert.equal(turn.denied[0].tool, 'ReadFile');
  assert.equal(turn.denied[0].path, '/etc/hosts');
  assert.match(turn.denied[0].reason, /^agy gave no reason; inferred: /);
  // One completion for the step, and it says failed: never completed, then corrected.
  const ends = toolEnds(notes);
  assert.equal(ends.length, 1, JSON.stringify(ends));
  assert.equal(ends[0].status, 'failed');
  assert.match(ends[0].error, /^Antigravity denied ReadFile on \/etc\/hosts in workspace-write mode \(agy gave no reason; inferred: /);
  assert.match(said(notes)[0], /^Antigravity denied ReadFile on \/etc\/hosts \(agy gave no reason; inferred: .*\) in workspace-write mode and ended the turn\.$/);
});

test('a refused read, then a read of a missing workspace file reported DONE with no output (T1): only the refused path is denied', async t => {
  const { notes, turn } = await agyTurn(t, [...refusedRead(3, '/tmp/outside-marker.txt'), ...silentRead(4, 'docs/missing.md'), result(deniedRead)]);
  assert.deepEqual(turn.denied, [{ tool: 'ReadFile', path: '/tmp/outside-marker.txt', reason: REASON }]);
  assert.deepEqual(toolEnds(notes).map(item => [item.detail?.input?.Path ?? item.detail?.filePath, item.status]), [['/tmp/outside-marker.txt', 'failed'], ['docs/missing.md', 'completed']]);
});

test('a missing-file read inside the workspace is never taken for the denial, even when it is the only DONE step (absolute path)', async t => {
  // The absolute form of the T1 shape: agy named the denied tool, but its only step is inside the workspace.
  const run = await agyTurnAbsolute(t);
  assert.deepEqual(run.turn.denied, [{ tool: 'ReadFile', path: null, reason: 'agy gave no reason' }]);
  assert.deepEqual(toolEnds(run.notes).map(item => item.status), ['completed']);
});

/** A turn whose one DONE/no-output read names an absolute path inside the workspace. */
async function agyTurnAbsolute(t: TestContext) {
  const defer = teardown(t);
  const dir = await mkdtemp(path.join(tmpdir(), 'alp-agy-denied-abs-'));
  defer(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const workspace = path.join(dir, 'workspace');
  await initProject(workspace);
  const script = path.join(dir, 'replay.mjs');
  await writeFile(script, REPLAY);
  const frames = [...silentRead(3, path.join(workspace, 'missing.md')), result(deniedRead)];
  const transport = new AntigravityTransport(process.execPath, workspace, { PATH: process.env.PATH, FRAMES: JSON.stringify(frames) }, { id: 'antigravity', label: 'Antigravity', command: process.execPath, args: [script] });
  defer(() => transport.close());
  const notes: Note[] = [];
  transport.onNotification((method, params) => notes.push({ method, params }));
  transport.onFailure(() => {});
  await transport.request('thread/start', { cwd: workspace, sandbox: 'workspace-write', model: 'gemini-3.8-flash-high' });
  await transport.request('turn/start', { input: [{ type: 'text', text: 'go' }] });
  await until(() => notes.some(note => note.method === 'turn/completed'), 'turn/completed');
  return { notes, turn: notes.find(note => note.method === 'turn/completed')!.params.turn };
}

test('a DONE read with no output outside the workspace is not a denial unless agy lists one: it completes, and the turn carries no denied', async t => {
  const { notes, turn } = await agyTurn(t, [...silentRead(3, '/tmp/no-such-file.txt'), result()]);
  assert.equal(turn.denied, undefined);
  assert.equal(turn.answered, undefined);
  const ends = toolEnds(notes);
  assert.deepEqual(ends.map(item => item.status), ['completed']);
  // The held step is emitted before its turn ends.
  assert.ok(notes.findIndex(note => note.method === 'item/completed' && note.params.item.id === ends[0].id) < notes.findIndex(note => note.method === 'turn/completed'));
});

test('a held step is released when agy goes on: the next step shows it was not the refused one', async t => {
  const { notes, turn } = await agyTurn(t, [...silentRead(3, '/tmp/a.txt'), ...refusedRead(4, '/etc/hosts'), result(deniedRead)]);
  assert.deepEqual(turn.denied, [{ tool: 'ReadFile', path: '/etc/hosts', reason: REASON }]);
  assert.deepEqual(toolEnds(notes).map(item => item.status), ['completed', 'failed']);
});

test('a held step is never left running: an interrupt ends it as agy reported it', async t => {
  const { notes, turn } = await agyTurn(t, [...silentRead(3, '/tmp/a.txt'), { hang: true }], {
    after: async (transport, seen) => {
      await until(() => seen.some(note => note.method === 'item/started'), 'the read');
      await new Promise(resolve => setTimeout(resolve, 50));
      await transport.request('turn/interrupt', {});
    },
  });
  assert.equal(turn.status, 'interrupted');
  assert.equal(turn.denied, undefined);
  assert.deepEqual(toolEnds(notes).map(item => item.status), ['completed']);
});

test('a held step is never left running: agy exiting mid-turn ends it as agy reported it', async t => {
  // A process that dies is reported through onFailure (the runtime fails the session), not turn/completed.
  const defer = teardown(t);
  const dir = await mkdtemp(path.join(tmpdir(), 'alp-agy-denied-exit-'));
  defer(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const script = path.join(dir, 'replay.mjs');
  await writeFile(script, REPLAY);
  const frames = [...silentRead(3, '/tmp/a.txt'), { exit: 3 }];
  const transport = new AntigravityTransport(process.execPath, dir, { PATH: process.env.PATH, FRAMES: JSON.stringify(frames) }, { id: 'antigravity', label: 'Antigravity', command: process.execPath, args: [script] });
  defer(() => transport.close());
  const notes: Note[] = [];
  let failure: unknown;
  transport.onNotification((method, params) => notes.push({ method, params }));
  transport.onFailure(error => { failure = error; });
  await transport.request('thread/start', { cwd: dir, sandbox: 'workspace-write', model: 'gemini-3.8-flash-high' });
  await transport.request('turn/start', { input: [{ type: 'text', text: 'go' }] });
  await until(() => failure, 'the failure');
  assert.deepEqual(toolEnds(notes).map(item => item.status), ['completed']);
});

test('an edit read-only refuses that agy marked DONE is named with its path, and the reason says agy gave none', async t => {
  const edit = (state: string) => ({ state, step_type: 'tool', tool_name: 'write_to_file', tool_info: { name: 'write_to_file', parameters: { TargetFile: 'src/a.js', CodeContent: 'x' } } });
  const { notes, turn } = await agyTurn(t, [step(3, edit('ACTIVE')), step(3, edit('DONE')), result({ denied_actions: [{ action: 'write_to_file', display_name: 'WriteFile' }] })], { mode: 'read-only' });
  assert.deepEqual(turn.denied, [{ tool: 'WriteFile', path: 'src/a.js', reason: 'agy gave no reason; agy reported this step done, and read-only mode refuses write_to_file' }]);
  assert.deepEqual(toolEnds(notes).map(item => item.status), ['failed']);
});

test('full access holds nothing: agy denies nothing there', async t => {
  const { notes } = await agyTurn(t, [...silentRead(3, '/tmp/a.txt'), { hang: true }], {
    mode: 'full-access',
    after: async (transport, seen) => {
      await until(() => seen.some(note => note.method === 'item/completed'), 'the read, unheld');
      await transport.request('turn/interrupt', {});
    },
  });
  assert.deepEqual(toolEnds(notes).map(item => item.status), ['completed']);
});

test('an answer after the denial is an answer: agy\'s response, or agent text after the last tool step', async t => {
  const byResponse = await agyTurn(t, [...refusedRead(3, '/etc/hosts'), result({ ...deniedRead, response: 'I could not read /etc/hosts; here is what I found instead.' })]);
  assert.equal(byResponse.turn.answered, true);
  assert.equal(byResponse.turn.denied.length, 1);
  const byText = await agyTurn(t, [...refusedRead(3, '/etc/hosts'), step(4, { state: 'ACTIVE', step_type: 'agent_response', text_delta: 'I could not read it.' }), step(4, { state: 'DONE', step_type: 'agent_response' }), result(deniedRead)]);
  assert.equal(byText.turn.answered, true);
  // Text before the refused step is not an answer to it.
  const before = await agyTurn(t, [step(2, { state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Reading it now.' }), step(2, { state: 'DONE', step_type: 'agent_response' }), ...refusedRead(3, '/etc/hosts'), result(deniedRead)]);
  assert.equal(before.turn.answered, false);
});

// --- The runtime: what the requester of the assignment gets. Codex-shaped scripted agents. ---

async function tree(t: TestContext) {
  const defer = teardown(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-denied-runtime-'));
  defer(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const root = path.join(directory, 'project');
  await initProject(root);
  const runs = path.join(directory, 'runs');
  const agents: FakeAgent[] = [];
  const runtime = createAlpRuntime({ language: 'English', transport: fakeTransport(agents), supervisor: false, libraryDir: path.join(directory, 'home'), runLogDir: runs });
  defer(() => runtime.shutdown());
  await runtime.open('root', { cwd: root });
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Go' }] });
  await until(() => agents[0]?.turnId, 'main turn');
  const runLog = async () => (await readFile(path.join(runs, 'root.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const main = agents[0];
  /** Delegates one peer assignment, lets `act` drive the peer, and returns the result main receives. */
  const assign = async (act: (agent: FakeAgent) => unknown, extra = {}) => {
    const count = agents.length;
    const { assignmentId } = await main.call('alp_delegate', { agent: 'peer', task: 'Change the file', mode: 'read-only', wait: false, ...extra });
    assert.ok(assignmentId);
    await until(() => agents.length > count && agents.at(-1)!.turnId, 'peer turn');
    await act(agents.at(-1)!);
    const answer = await main.call('alp_wait', { assignments: [assignmentId] });
    return answer.events.find((event: Json) => event.kind === 'result' && event.assignment === assignmentId).result;
  };
  return { root, runtime, runLog, assign };
}

const DENIED = [{ tool: 'ReadFile', path: '/etc/hosts', reason: REASON }];
/** Ends a scripted agent's turn the way the Antigravity transport ends one that agy denied. */
const deniedTurn = (agent: FakeAgent, { answered = false } = {}) => {
  agent.notification!('item/completed', { threadId: agent.threadId, item: { type: 'agentMessage', id: `denied-${agent.turnId}`, text: `Antigravity denied ReadFile on /etc/hosts (${REASON}) in workspace-write mode and ended the turn.` } });
  agent.notification!('turn/completed', { threadId: agent.threadId, turn: { id: agent.turnId, status: 'completed', denied: DENIED, answered, mode: 'workspace-write' } });
};

test('other runtimes are unchanged: a Codex/Claude-shaped turn with no denied, no answer and no handoff completes exactly as before', async t => {
  const { assign, runLog } = await tree(t);
  const result = await assign(agent => agent.finish(''));
  assert.equal(result.status, 'completed');
  assert.equal(result.handoff, null);
  assert.equal(result.error, undefined);
  assert.equal('denied' in result, false);
  assert.deepEqual(Object.keys(result).sort(), ['agent', 'handoff', 'output', 'runtime', 'sessionId', 'status', 'threadId']);
  assert.equal((await runLog()).some(entry => entry.event === 'turn.denied'), false);
  // And one with a handoff, the ordinary success.
  const handed = await assign(async agent => { await agent.call('alp_handoff', { outcome: 'complete', summary: 'Changed it' }); agent.finish('Done'); });
  assert.equal(handed.status, 'completed');
  assert.equal('denied' in handed, false);
});

test('a turn that ended on a denial with no answer and no handoff fails the assignment, names the denial, and returns its task to open', async t => {
  const { root, assign, runLog } = await tree(t);
  const task = await createTask(root, { title: 'Change the file' }, 'user');
  const result = await assign(agent => deniedTurn(agent), { taskId: task.id });
  assert.equal(result.status, 'failed');
  assert.equal(result.handoff, null);
  assert.deepEqual(result.denied, DENIED);
  assert.equal(result.error, `peer's turn ended because ReadFile on /etc/hosts was denied (${REASON}) in workspace-write mode; no handoff was filed.`);
  // A failed assignment's task goes back to open, as for any failed assignment.
  assert.equal(result.task.status, 'open');
  assert.equal((await getTask(root, task.id)).status, 'open');
  const log = await runLog();
  const line = log.find(entry => entry.event === 'turn.denied');
  assert.deepEqual([line.agent, line.mode, line.answered, line.denied], ['peer', 'workspace-write', false, DENIED]);
  const finished = log.find(entry => entry.event === 'assignment.finished');
  assert.deepEqual([finished.status, finished.denied], ['failed', DENIED]);
});

test('a handoff after the denial keeps the assignment completed, with denied', async t => {
  const { assign } = await tree(t);
  const result = await assign(async agent => {
    await agent.call('alp_handoff', { outcome: 'partial', summary: 'Could not read /etc/hosts; did the rest' });
    deniedTurn(agent);
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.handoff.outcome, 'partial');
  assert.deepEqual(result.denied, DENIED);
  assert.equal(result.error, undefined);
});

test('an answer after the denial keeps the assignment completed, with denied', async t => {
  const { assign } = await tree(t);
  const result = await assign(agent => deniedTurn(agent, { answered: true }));
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.denied, DENIED);
});
