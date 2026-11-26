// t-4b59: a workspace-write Antigravity role opens its own library skill.
// Measured 2026-11-24 (agy 1.5.15, macOS, workspace-write; t-9ae1 R1 and M0): main read a file in its
// workspace, then agy's own read_file of <ALP_HOME>/skills/bug-loop/SKILL.md was denied ("permission
// check failed for read_file … user denied permission"), and agy ended the whole turn with an empty
// answer: no edit, no test, no handoff. The library lies outside every workspace, so a role that
// followed "read its SKILL.md" lost its turn.
// The assignment's agy below behaves as that model did: it opens the first skill its instructions list
// the way they say. When they give the skill's path, it reads the path with read_file and agy denies it
// exactly as measured; when they name alp_skill_read, it calls that ALP tool, then edits a workspace
// file, runs a test and files its handoff. agy's permission flags are the same in both.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '@anhlp/alp-core/init';
import { saveEntry } from '@anhlp/alp-core/library-edit';
import { createAlpRuntime } from '../../dist/runtime/index.js';
import { teardown } from '../support/teardown.ts';

const FAKE_AGY = fileURLToPath(new URL('../support/fake-agy.ts', import.meta.url));
const MODEL = 'antigravity:claude-sonnet-4-6';

// Every Antigravity session of the test runs this. A workspace-write session (the assignment) is the
// replay; any other session (the requester, full-access) is the ordinary fake agy, which calls ALP's tools.
const REPLAY_AGY = `
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const args = process.argv.slice(2);
const at = args.indexOf('--mode');
const log = value => appendFileSync(process.env.REPLAY_LOG, JSON.stringify(value) + '\\n');
log({ op: 'start', args });
if (at < 0 || args[at + 1] !== 'accept-edits') {
  const child = spawn(process.execPath, [process.env.REPLAY_FAKE_AGY, ...args], { stdio: 'inherit' });
  child.on('exit', code => process.exit(code ?? 1));
} else {
  const send = frame => process.stdout.write(JSON.stringify(frame) + '\\n');
  const conversation = 'replay-' + process.pid;
  let index = 0;
  const step = extra => send({ event: 'step_update', step_update: { conversation_id: conversation, step_index: index, ...extra } });
  const tool = (name, parameters, end) => { ++index; step({ state: 'ACTIVE', step_type: 'tool', tool_name: name, tool_info: { name, parameters } }); step({ step_type: 'tool', tool_name: name, ...end(name, parameters) }); };
  // ALP's MCP server, as agy starts it: the launcher in the MCP configuration, with agy's environment.
  async function mcp(calls) {
    const server = JSON.parse(readFileSync(process.env.ALP_AGY_MCP_CONFIG, 'utf8')).mcpServers.alp;
    const child = spawn(server.command, server.args ?? [], { env: { ...process.env, ...(server.env ?? {}) }, stdio: ['pipe', 'pipe', 'inherit'] });
    const replies = new Map();
    createInterface({ input: child.stdout }).on('line', line => { try { const m = JSON.parse(line); replies.get(m.id)?.(m); } catch {} });
    let id = 0;
    const request = (method, params) => new Promise(resolve => { replies.set(++id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n'); });
    try {
      await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'replay-agy', version: '1' } });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\\n');
      const out = [];
      for (const call of calls) out.push(call === 'list' ? (await request('tools/list', {})).result : (await request('tools/call', { name: call.name, arguments: call.arguments })).result);
      return out;
    } finally { child.stdin.end(); child.kill(); }
  }
  const text = result => result?.content?.map(part => part.text).join('') ?? '';
  send({ event: 'init', conversation_id: conversation, init: { model: 'claude-sonnet-4-6' } });
  createInterface({ input: process.stdin }).on('line', async line => {
    const prompt = JSON.parse(line).prompt ?? JSON.parse(line).message?.content ?? '';
    log({ op: 'prompt', prompt });
    ++index; step({ state: 'DONE', step_type: 'user_input' });
    // R1: a workspace file reads fine.
    tool('view_file', { AbsolutePath: process.cwd() + '/ALP.md' }, () => ({ state: 'DONE', tool_info: { name: 'view_file', output: 'ALP.md' } }));
    const listed = [...prompt.matchAll(/^- (bug-loop)(?: \\(([^)]+)\\))?(?::|$)/gm)].find(match => match[2]);
    if (listed?.[2]) {
      // The listing gives a path: the model reads it with agy's own tool, and agy denies it (M0).
      const denial = 'permission check failed for read_file "' + listed[2] + '": user denied permission for read_file(' + listed[2] + ')';
      tool('read_file', { Path: listed[2] }, (name, parameters) => ({ state: 'ERROR', tool_info: { name, parameters, error: { type: 'TOOL_ERROR', message: denial } } }));
      send({ event: 'result', result: { conversation_id: conversation, status: 'SUCCESS', response: '', denied_actions: [{ action: 'read_file', display_name: 'ReadFile' }] } });
      return;
    }
    // The listing names alp_skill_read: the model opens the skill through ALP, then one of its references.
    const [tools, skill, reference, outside, foreign] = await mcp(['list',
      { name: 'alp_skill_read', arguments: { skill: 'bug-loop' } },
      { name: 'alp_skill_read', arguments: { skill: 'bug-loop', file: 'references/test-proof.md' } },
      { name: 'alp_skill_read', arguments: { skill: 'bug-loop', file: '../../role-skills.json' } },
      { name: 'alp_skill_read', arguments: { skill: 'goal-griller' } }]);
    log({ op: 'skill', tools: tools.tools.map(t => t.name), skill, reference, outside, foreign });
    // Then its work: edit a workspace file, run a test, file the handoff.
    tool('write_to_file', { TargetFile: process.cwd() + '/fixed.txt' }, () => { writeFileSync(process.cwd() + '/fixed.txt', 'fixed\\n'); return { state: 'DONE', tool_info: { name: 'write_to_file', output: 'ok' } }; });
    const run = spawnSync(process.execPath, ['-e', 'process.exit(require("fs").readFileSync("fixed.txt","utf8")==="fixed\\\\n"?0:1)'], { cwd: process.cwd() });
    tool('run_command', { CommandLine: 'node -e <check fixed.txt>' }, () => ({ state: 'DONE', tool_info: { name: 'run_command', output: 'exit ' + run.status } }));
    const opened = JSON.parse(text(skill));
    const [handoff] = await mcp([{ name: 'alp_handoff', arguments: { outcome: 'complete', summary: 'Used skill ' + opened.skill + ' (' + opened.content.split('\\n')[1] + '); edited fixed.txt; test exit ' + run.status, verification: ['node -e check: exit ' + run.status] } }]);
    log({ op: 'handoff', handoff });
    ++index; step({ state: 'DONE', step_type: 'agent_response', text_delta: 'Done: skill bug-loop, fixed.txt, test exit ' + run.status });
    send({ event: 'result', result: { conversation_id: conversation, status: 'SUCCESS', response: 'Done: skill bug-loop, fixed.txt, test exit ' + run.status } });
  });
}
`;

// `any`: event envelopes are a union over every event type; the tests read the fields of the ones they filter.
type Json = any;

async function setup(t: TestContext) {
  const defer = teardown(t);
  const dir = await mkdtemp(path.join(tmpdir(), 'alp-agy-skill-'));
  // Undone LAST: the runtime and every agy child have stopped before the directory goes.
  defer(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const root = path.join(dir, 'project');
  const home = path.join(dir, 'home');
  const replay = path.join(dir, 'replay-agy.mjs');
  const mcpConfig = path.join(dir, 'mcp_config.json');
  await writeFile(replay, REPLAY_AGY);
  await initProject(root);
  await writeFile(path.join(root, '.alp', 'settings.json'), JSON.stringify({ defaultAgent: 'main', workflow: { mode: 'pho', supervisor: false } }));
  await saveEntry('providers', 'antigravity', {
    provider: {
      kind: 'antigravity', label: 'Antigravity', command: process.execPath, args: [replay],
      env: { REPLAY_FAKE_AGY: FAKE_AGY, REPLAY_LOG: path.join(dir, 'replay.jsonl'), ALP_AGY_MCP_CONFIG: mcpConfig },
    },
  }, { scope: 'library', library: home });
  const runtime = createAlpRuntime({
    environment: { ...process.env, ALP_AGY_MCP_CONFIG: mcpConfig },
    language: 'English', supervisor: false, libraryDir: home, runLogDir: path.join(dir, 'runs'),
  });
  const events: Json[] = [];
  runtime.onEvent(envelope => events.push(envelope));
  defer(() => runtime.shutdown());
  await runtime.open('root', { cwd: root, model: MODEL, mode: 'full-access' });
  return { dir, root, home, runtime, events };
}

async function until(check: () => unknown, what: string) {
  for (let i = 0; i < 4000; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`${what} did not arrive`);
}

/** Delegates one workspace-write peer on Antigravity and returns what the requester's alp_delegate got back. */
async function delegate({ runtime, events }: Awaited<ReturnType<typeof setup>>) {
  const task = 'Fix the bug: open the library skill bug-loop first, edit fixed.txt, run the check, and file your handoff.';
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: `call_tool alp_delegate ${JSON.stringify({ agent: 'peer', model: MODEL, mode: 'workspace-write', wait: true, task })}` }] });
  await until(() => events.some((entry: Json) => entry.sessionId === 'root' && entry.event.type === 'turn.ended'), 'the requester turn');
  const said = events.filter((entry: Json) => entry.sessionId === 'root' && entry.event.type === 'item' && entry.event.item.kind === 'assistant_message').map(entry => entry.event.item.text).at(-1);
  const match = /^tool alp_delegate: (.*)$/s.exec(said ?? '');
  assert.ok(match, `the requester got the delegate result: ${said}`);
  const reply = JSON.parse(match[1]);
  return { reply, result: JSON.parse(reply.content[0].text) };
}

const replayLog = async (dir: string) => (await readFile(path.join(dir, 'replay.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));

test('the measured sequence: a skill listed by path is read with agy\'s read_file, agy denies it and the turn ends with no edit and no handoff', async t => {
  const setupResult = await setup(t);
  const { home, root } = setupResult;
  const { runtime, events } = setupResult;
  const skillPath = path.join(home, 'skills', 'bug-loop', 'SKILL.md');
  // The listing as origin/main gave it, with the skill's SKILL.md path under <ALP_HOME>/skills; here in the brief.
  const task = `Fix the bug.\n- bug-loop (${skillPath}): diagnose a bug`;
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: `call_tool alp_delegate ${JSON.stringify({ agent: 'peer', model: MODEL, mode: 'workspace-write', wait: true, task })}` }] });
  await until(() => events.some((entry: Json) => entry.sessionId === 'root' && entry.event.type === 'turn.ended'), 'the requester turn');
  const said = events.filter((entry: Json) => entry.sessionId === 'root' && entry.event.type === 'item' && entry.event.item.kind === 'assistant_message').map(entry => entry.event.item.text).at(-1);
  const reply = JSON.parse(/^tool alp_delegate: (.*)$/s.exec(said ?? '')![1]);
  assert.equal(reply.isError, true, said);
  const result = JSON.parse(reply.content[0].text);
  assert.equal(result.status, 'failed');
  assert.equal(result.handoff, null);
  assert.deepEqual(result.denied.map((entry: Json) => [entry.tool, entry.path]), [['ReadFile', skillPath]]);
  assert.match(result.denied[0].reason, /user denied permission for read_file/);
  await assert.rejects(readFile(path.join(root, 'fixed.txt')), /ENOENT/);
});

test('a workspace-write Antigravity peer opens its library skill with alp_skill_read, edits, runs a test and hands off; nothing outside the skill is returned', async t => {
  const setupResult = await setup(t);
  const { dir, root, home } = setupResult;
  const { reply, result } = await delegate(setupResult);
  assert.notEqual(reply.isError, true, JSON.stringify(result));
  assert.equal(result.agent, 'peer');
  assert.equal(result.runtime, 'antigravity');
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.match(result.handoff.summary, /^Used skill bug-loop \(name: bug-loop\); edited fixed.txt; test exit 0$/);
  assert.equal(await readFile(path.join(root, 'fixed.txt'), 'utf8'), 'fixed\n');
  assert.equal(result.denied, undefined);

  const entries = await replayLog(dir);
  // The peer's instructions name the tool and give no path into the library.
  const peerPrompt = entries.filter(entry => entry.op === 'prompt').map(entry => entry.prompt).find(text => text.includes('Fix the bug: open the library skill'));
  assert.ok(peerPrompt, 'the peer got its brief');
  assert.match(peerPrompt, /open it with alp_skill_read \{"skill": "<name>"\}/);
  assert.match(peerPrompt, /^- bug-loop: /m);
  assert.ok(!peerPrompt.includes(path.join(home, 'skills')), 'no library path in the peer\'s instructions');
  const used = entries.find(entry => entry.op === 'skill');
  assert.ok(used.tools.includes('alp_skill_read'), used.tools.join(','));
  const body = (value: Json) => JSON.parse(value.content[0].text);
  assert.equal(used.skill.isError, false);
  assert.equal(body(used.skill).file, 'SKILL.md');
  assert.match(body(used.skill).content, /^---\nname: bug-loop\n/);
  assert.deepEqual(body(used.skill).files, ['references/test-proof.md']);
  assert.equal(used.reference.isError, false);
  assert.equal(body(used.reference).file, 'references/test-proof.md');
  // Outside the skill, and a skill of another role, are refused.
  assert.equal(used.outside.isError, true);
  assert.match(body(used.outside).error, /stay inside skill 'bug-loop'/);
  assert.equal(used.foreign.isError, true);
  assert.match(body(used.foreign).error, /'goal-griller' is not one of your skills/);
  // agy ran with the same flags as before: no added directory, no read permission.
  const peerStart = entries.find(entry => entry.op === 'start' && entry.args.includes('accept-edits'));
  assert.ok(peerStart, 'the peer ran in workspace-write');
  assert.ok(!peerStart.args.some((arg: string) => arg.includes(path.join(home, 'skills'))), peerStart.args.join(' '));
  // The run log records the skill's use and the reference it opened.
  const runLog = (await readFile(path.join(dir, 'runs', 'root.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(runLog.filter(entry => entry.event === 'skill' && entry.agent === 'peer').map(entry => [entry.skill, entry.via]), [['bug-loop', 'tool']]);
  assert.deepEqual(runLog.filter(entry => entry.event === 'skill-resource' && entry.agent === 'peer').map(entry => entry.resource), ['references/test-proof.md']);
});
