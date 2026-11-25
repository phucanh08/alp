// t-a648: what a requester receives when agy denies a tool inside an assignment and ends the turn.
// The assignment fails, its error names the tool, the path, the mode and agy's reason (or says agy
// gave none), and the result carries `denied: [{tool, path, reason}]`.
// The assignment's agy replays the frames agy 1.5.15 sent in measurement M0 (2026-11-24, macOS,
// gemini-3.8-flash-high, workspace-write): a read_file outside the workspace is refused, agy ends
// the whole turn with an empty answer and `denied_actions`, and no handoff is ever filed. In one
// variant agy reports the refused step as ERROR; in the other (the library-skill read) it reports
// it DONE with no output, so only `denied_actions` shows the refusal. A third follows T1 (agy
// 1.5.16, as the evidence doc records it): the refused read, then a read of a workspace file that
// does not exist, reported DONE with no output, which must not be taken for the denial.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '../../packages/core/src/init.js';
import { saveEntry } from '../../packages/core/src/library/entries/library-edit.js';
import { createAlpRuntime } from '../../dist/runtime/index.js';
import { teardown } from '../support/teardown.js';

const FAKE_AGY = fileURLToPath(new URL('../support/fake-agy.js', import.meta.url));
const MODEL = 'antigravity:gemini-3.8-flash-high';
const DENIAL = 'permission check failed for read_file "/private/etc/hosts": user denied permission for read_file(/private/etc/hosts)\nDo not attempt to circumvent this denial by rephrasing the command, using alternative tools/scripts (e.g. python, sh, curl), or accessing the same target resource. Proceed without performing this action.';

// The provider command for every Antigravity session of the test. A workspace-write session (the
// assignment) replays the measured frames; any other session (the requester, full-access) is the
// ordinary fake agy, which can call ALP's tools.
const REPLAY_AGY = `
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
const at = args.indexOf('--mode');
if (at < 0 || args[at + 1] !== 'accept-edits') {
  const child = spawn(process.execPath, [process.env.REPLAY_FAKE_AGY, ...args], { stdio: 'inherit' });
  child.on('exit', code => process.exit(code ?? 1));
} else {
  const send = frame => process.stdout.write(JSON.stringify(frame) + '\\n');
  const conversation = args.includes('--conversation') ? args[args.indexOf('--conversation') + 1] : 'replay-' + process.pid;
  const step = (index, extra) => send({ event: 'step_update', step_update: { conversation_id: conversation, step_index: index, ...extra } });
  send({ event: 'init', conversation_id: conversation, init: { model: 'gemini-3.8-flash-high', tools: ['view_file', 'write_to_file', 'run_command'] } });
  let index = 0;
  createInterface({ input: process.stdin }).on('line', line => {
    appendFileSync(process.env.REPLAY_LOG, line + '\\n');
    const read = { name: 'read_file', parameters: { Path: '/etc/hosts' } };
    step(++index, { state: 'DONE', step_type: 'user_input' });
    step(++index, { state: 'DONE', step_type: 'agent_response', usage: { input_tokens: 2810, output_tokens: 471 } });
    step(++index, { state: 'ACTIVE', step_type: 'tool', tool_name: 'read_file', tool_info: read });
    step(index, process.env.REPLAY_VARIANT === 'done'
      ? { state: 'DONE', step_type: 'tool', tool_name: 'read_file', tool_info: read }
      : { state: 'ERROR', step_type: 'tool', tool_name: 'read_file', tool_info: { ...read, error: { type: 'TOOL_ERROR', message: process.env.REPLAY_DENIAL } } });
    if (process.env.REPLAY_VARIANT === 't1') {
      const missing = { name: 'read_file', parameters: { Path: process.cwd() + '/docs/missing.md' } };
      step(++index, { state: 'ACTIVE', step_type: 'tool', tool_name: 'read_file', tool_info: missing });
      step(index, { state: 'DONE', step_type: 'tool', tool_name: 'read_file', tool_info: missing });
    }
    send({ event: 'result', result: { conversation_id: conversation, status: 'SUCCESS', response: '', denied_actions: [{ action: 'read_file', display_name: 'ReadFile' }] } });
  });
}
`;

async function setup(t, variant) {
  const defer = teardown(t);
  const dir = await mkdtemp(path.join(tmpdir(), 'alp-agy-denied-'));
  // Undone LAST: the runtime and every agy child have stopped before the directory goes.
  defer(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const root = path.join(dir, 'project');
  const home = path.join(dir, 'home');
  const replay = path.join(dir, 'replay-agy.mjs');
  await writeFile(replay, REPLAY_AGY);
  await initProject(root);
  await writeFile(path.join(root, '.alp', 'settings.json'), JSON.stringify({ defaultAgent: 'main', workflow: { mode: 'pho', supervisor: false } }));
  await saveEntry('providers', 'antigravity', {
    provider: {
      kind: 'antigravity',
      label: 'Antigravity',
      command: process.execPath,
      args: [replay],
      env: {
        REPLAY_FAKE_AGY: FAKE_AGY,
        REPLAY_VARIANT: variant,
        REPLAY_DENIAL: DENIAL,
        REPLAY_LOG: path.join(dir, 'replay.jsonl'),
        FAKE_AGY_LOG: path.join(dir, 'agy.jsonl'),
        ALP_AGY_MCP_CONFIG: path.join(dir, 'mcp_config.json'),
      },
    },
  }, { scope: 'library', library: home });
  const runtime = createAlpRuntime({
    environment: { ...process.env, ALP_AGY_MCP_CONFIG: path.join(dir, 'mcp_config.json') },
    language: 'English',
    supervisor: false,
    libraryDir: home,
    runLogDir: path.join(dir, 'runs'),
  });
  const events = [];
  runtime.onEvent(envelope => events.push(envelope));
  defer(() => runtime.shutdown());
  await runtime.open('root', { cwd: root, model: MODEL, mode: 'full-access' });
  return { dir, runtime, events };
}

async function until(check, what) {
  for (let i = 0; i < 2000; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`${what} did not arrive`);
}

/** Delegates one workspace-write assignment that agy's denial fails, and returns what the requester's alp_delegate got back. */
async function delegate({ runtime, events }) {
  const task = 'Open the library skill you need, then make the change and file your handoff.';
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: `call_tool alp_delegate ${JSON.stringify({ agent: 'peer', model: MODEL, mode: 'workspace-write', wait: true, task })}` }] });
  const ended = entry => entry.sessionId === 'root' && entry.event.type === 'turn.ended';
  await until(() => events.some(ended), 'the requester turn');
  const said = events.filter(entry => entry.sessionId === 'root' && entry.event.type === 'item' && entry.event.item.kind === 'assistant_message').map(entry => entry.event.item.text).at(-1);
  const match = /^tool alp_delegate: (.*)$/s.exec(said ?? '');
  assert.ok(match, `the requester got the delegate result: ${said}`);
  const reply = JSON.parse(match[1]);
  // A failed assignment comes back to alp_delegate as an error result (t-a648); its payload is checked by each test.
  assert.equal(reply.isError, true, said);
  const result = JSON.parse(reply.content[0].text);
  const child = events.filter(entry => entry.sessionId === result.sessionId).map(entry => entry.event);
  return { result, child };
}

const REASON = DENIAL.split('\n')[0];
const INFERRED = /^agy gave no reason; inferred: agy reported this step done with no output, outside the workspace, and listed ReadFile as denied$/;

for (const variant of ['error', 'done', 't1']) {
  test(`a denied tool fails an Antigravity assignment that filed no handoff; the requester gets the tool, path, mode and reason (agy step ${variant.toUpperCase()})`, async t => {
    const setupResult = await setup(t, variant);
    const { result, child } = await delegate(setupResult);
    assert.equal(result.agent, 'peer');
    assert.equal(result.runtime, 'antigravity');
    assert.equal(result.status, 'failed');
    assert.equal(result.handoff, null);
    // Machine-readable: one entry for agy's one denied action, with the refused step's path.
    assert.equal(result.denied.length, 1, JSON.stringify(result.denied));
    const [denied] = result.denied;
    assert.equal(denied.tool, 'ReadFile');
    assert.equal(denied.path, '/etc/hosts');
    if (variant === 'done') assert.match(denied.reason, INFERRED);
    else assert.equal(denied.reason, REASON);
    // The sentence the requester reads, and the line the assignment's timeline ends with.
    assert.equal(result.error, `peer's turn ended because ReadFile on /etc/hosts was denied (${denied.reason}) in workspace-write mode; no handoff was filed.`);
    assert.equal(result.output, `Antigravity denied ReadFile on /etc/hosts (${denied.reason}) in workspace-write mode and ended the turn.`);
    // The assignment's own record of its reads: the refused one failed, whatever agy called it.
    const reads = child.filter(event => event.type === 'item' && event.item.kind === 'tool_call' && event.item.name === 'read_file' && event.item.status !== 'running').map(event => event.item);
    assert.equal(reads.length, variant === 't1' ? 2 : 1, JSON.stringify(child.filter(event => event.type === 'item').map(event => event.item)));
    assert.equal(reads[0].status, 'failed');
    if (variant === 'done') assert.match(JSON.stringify(reads[0]), /Antigravity denied ReadFile on \/etc\/hosts in workspace-write mode \(agy gave no reason; inferred: /);
    else assert.match(JSON.stringify(reads[0]), /user denied permission for read_file\(\/private\/etc\/hosts\)/);
    // T1: the missing workspace file agy reported DONE with no output is a completed read, not the denial.
    if (variant === 't1') assert.equal(reads[1].status, 'completed');
    assert.match(await readFile(path.join(setupResult.dir, 'replay.jsonl'), 'utf8'), /library skill you need/);
    // The run log names the denial, and the finished assignment carries it.
    const runLog = (await readFile(path.join(setupResult.dir, 'runs', 'root.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(runLog.find(entry => entry.event === 'turn.denied')?.denied, result.denied);
    assert.equal(runLog.find(entry => entry.event === 'assignment.finished')?.status, 'failed');
  });
}
