// t-7679.13: typed tool-call details from real transports driving the fake agents: an ACP agent's
// read and edit calls, an Antigravity agent's native tool steps, and Claude Code's Read through the
// Claude Agent SDK, each as a typed detail from the running item on.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '../../packages/core/src/init.js';
import { saveEntry } from '../../packages/core/src/library-edit.js';
import { createAlpRuntime } from '../../dist/runtime/index.js';

const FAKE_ACP = fileURLToPath(new URL('../support/fake-acp.js', import.meta.url));
const FAKE_AGY = fileURLToPath(new URL('../support/fake-agy.js', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('../../packages/daemon/tests/support/fake-claude.js', import.meta.url));

async function until(check, what = 'Expected condition') {
  for (let i = 0; i < 1000; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(`${what} did not arrive`);
}

async function setup(t, { provider, options = {} } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'alp-tool-detail-'));
  const root = path.join(dir, 'project');
  const home = path.join(dir, 'home');
  await initProject(root);
  await writeFile(path.join(root, '.alp', 'settings.json'), JSON.stringify({ defaultAgent: 'main', workflow: { mode: 'pho', supervisor: false } }));
  if (provider) await saveEntry('providers', provider.name, { provider: provider.value }, { scope: 'library', library: home });
  const runtime = createAlpRuntime({ language: 'English', supervisor: false, libraryDir: home, runLogDir: path.join(dir, 'runs'), environment: { ...process.env, ALP_AGY_MCP_CONFIG: path.join(dir, 'mcp_config.json') }, ...options });
  const events = [];
  runtime.onEvent(envelope => events.push(envelope));
  t.after(async () => { await runtime.shutdown(); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  let prompts = 0;
  const turn = async text => {
    const id = `m${++prompts}`;
    const start = events.length;
    await runtime.prompt('root', { clientMessageId: id, delivery: 'auto', content: [{ type: 'text', text }] });
    await until(() => events.slice(start).some(entry => entry.event.type === 'turn.ended'), `the turn of ${text}`);
    return events.slice(start).filter(entry => entry.event.type === 'item' && entry.event.item.kind === 'tool_call').map(entry => entry.event.item);
  };
  return { root, runtime, turn };
}

test('an ACP agent\'s read, edit and search calls are typed; its running call shows what it reads', async t => {
  const { root, runtime, turn } = await setup(t, { provider: { name: 'fake', value: { kind: 'acp', label: 'Fake', command: process.execPath, args: [FAKE_ACP] } } });
  await runtime.open('root', { cwd: root, model: 'acp:fake' });
  const read = await turn(`fake:call ${JSON.stringify({ kind: 'read', title: 'Read a.ts', running: true, locations: [{ path: `${root}/a.ts` }], content: [{ type: 'content', content: { type: 'text', text: 'const a = 1;' } }] })}`);
  assert.deepEqual(read.map(item => [item.name, item.status, item.detail]), [
    ['Read a.ts', 'running', { type: 'unknown', input: null, output: null }],
    // The running update brought the path: the running item already shows it.
    ['Read a.ts', 'running', { type: 'read', filePath: `${root}/a.ts` }],
    ['Read a.ts', 'completed', { type: 'read', filePath: `${root}/a.ts`, content: 'const a = 1;' }],
  ]);
  // An update after the call was done neither reopens it nor replaces its detail.
  const edit = await turn(`fake:call ${JSON.stringify({ kind: 'edit', title: 'Edit a.ts', late: true, locations: [{ path: `${root}/a.ts` }], content: [{ type: 'diff', path: `${root}/a.ts`, oldText: 'a = 1', newText: 'a = 2' }] })}`);
  assert.deepEqual([edit.at(-1).status, edit.at(-1).detail], ['completed', { type: 'edit', filePath: `${root}/a.ts`, oldString: 'a = 1', newString: 'a = 2' }]);
  const failed = await turn(`fake:call ${JSON.stringify({ kind: 'search', title: 'grep', rawInput: { pattern: 'TODO' }, status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'rg: not found' } }] })}`);
  assert.deepEqual([failed.at(-1).status, failed.at(-1).error, failed.at(-1).detail.type], ['failed', 'rg: not found', 'search']);
  // A command stays a shell call.
  const ran = await turn('fake:exec npm test');
  assert.deepEqual([ran.at(-1).name, ran.at(-1).detail], ['shell', { type: 'shell', command: 'npm test', cwd: root, output: 'ran npm test', exitCode: 0 }]);
});

test('an Antigravity agent\'s native tool steps are typed: run_command a shell, view_file a read', async t => {
  const { root, runtime, turn } = await setup(t, { provider: { name: 'antigravity', value: { kind: 'antigravity', label: 'Antigravity', command: process.execPath, args: [FAKE_AGY] } } });
  await runtime.open('root', { cwd: root, model: 'antigravity:gemini-3.8-flash-high' });
  const view = await turn(`tool_step ${JSON.stringify({ name: 'view_file', parameters: { AbsolutePath: `${root}/a.ts` }, output: 'const a = 1;' })}`);
  assert.deepEqual(view.map(item => [item.name, item.status, item.detail]), [
    ['view_file', 'running', { type: 'read', filePath: `${root}/a.ts` }],
    ['view_file', 'completed', { type: 'read', filePath: `${root}/a.ts`, content: 'const a = 1;' }],
  ]);
  const run = await turn(`tool_step ${JSON.stringify({ name: 'run_command', parameters: { CommandLine: 'npm test' }, output: 'ok' })}`);
  assert.deepEqual([run.at(-1).name, run.at(-1).detail], ['shell', { type: 'shell', command: 'npm test', output: 'ok' }]);
  const failed = await turn(`tool_step ${JSON.stringify({ name: 'write_to_file', parameters: { TargetFile: `${root}/b.ts`, CodeContent: 'x' }, error: { type: 'denied', message: 'outside the workspace' } })}`);
  assert.deepEqual([failed.at(-1).status, failed.at(-1).error, failed.at(-1).detail], ['failed', 'outside the workspace', { type: 'write', filePath: `${root}/b.ts`, content: 'x' }]);
});

test('Claude Code\'s Read through the Agent SDK is a read with the SDK\'s structured content', { skip: process.platform === 'win32' && 'runs the fake by its shebang' }, async t => {
  const { root, runtime, turn } = await setup(t, { options: { claudeCommand: FAKE_CLAUDE } });
  await runtime.open('root', { cwd: root, model: 'claude:claude-opus-5-5' });
  const call = { input: { file_path: `${root}/a.ts` }, text: '     1\tconst a = 1;', structured: { type: 'text', file: { filePath: `${root}/a.ts`, content: 'const a = 1;\n', numLines: 1, startLine: 1, totalLines: 1 } } };
  const items = await turn(`[tool Read ${JSON.stringify(call)}]`);
  assert.deepEqual(items.map(item => [item.name, item.status, item.detail]), [
    ['Read', 'running', { type: 'read', filePath: `${root}/a.ts` }],
    ['Read', 'completed', { type: 'read', filePath: `${root}/a.ts`, content: 'const a = 1;\n', offset: 1 }],
  ]);
});

test('alp acp shows typed calls to the editor: kinds, titles relative to the session, diffs, locations', async () => {
  const { toolInput, toolKind, toolLocations, toolOutput, toolTitle } = await import('../../dist/acp/agent.js');
  const { toolLine } = await import('../../packages/cli/src/sessions.js');
  const item = (name, detail, extra = {}) => ({ kind: 'tool_call', id: 't', callId: 't', name, status: 'completed', detail, ...extra });
  const read = item('Read', { type: 'read', filePath: '/p/src/a.ts', content: 'const a = 1;', offset: 7, limit: 20 });
  assert.deepEqual([toolKind(read), toolTitle(read, '/p'), toolTitle(read, '/q'), toolOutput(read), toolInput(read), toolLocations(read)], [
    'read', 'Read src/a.ts', 'Read /p/src/a.ts', [{ type: 'content', content: { type: 'text', text: 'const a = 1;' } }], { filePath: '/p/src/a.ts', offset: 7, limit: 20 }, [{ path: '/p/src/a.ts', line: 7 }],
  ]);
  const edit = item('Edit', { type: 'edit', filePath: '/p/a.ts', oldString: 'a = 1', newString: 'a = 2' });
  assert.deepEqual([toolKind(edit), toolOutput(edit)], ['edit', [{ type: 'diff', path: '/p/a.ts', oldText: 'a = 1', newText: 'a = 2' }]]);
  const patch = item('apply_patch', { type: 'edit', filePath: '/p/a.ts', unifiedDiff: '@@ -1 +1 @@\n-a\n+b\n' });
  assert.deepEqual(toolOutput(patch), [{ type: 'content', content: { type: 'text', text: '```diff\n@@ -1 +1 @@\n-a\n+b\n```' } }]);
  const write = item('Write', { type: 'write', filePath: '/p/n.md', content: '# N' });
  assert.deepEqual([toolKind(write), toolOutput(write)], ['edit', [{ type: 'diff', path: '/p/n.md', oldText: null, newText: '# N' }]]);
  const web = item('WebSearch', { type: 'search', query: 'acp', toolName: 'web_search', webResults: [{ title: 'ACP', url: 'https://agentclientprotocol.com' }] });
  assert.deepEqual([toolKind(web), toolTitle(web), toolOutput(web)[0].content.text], ['fetch', 'Search the web acp', 'ACP — https://agentclientprotocol.com']);
  const grep = item('Grep', { type: 'search', query: 'TODO', toolName: 'grep', filePaths: ['a.ts', 'b.ts'] });
  assert.deepEqual([toolKind(grep), toolOutput(grep)[0].content.text], ['search', 'a.ts\nb.ts']);
  const failed = item('Edit', { type: 'edit', filePath: '/p/a.ts' }, { status: 'failed', error: 'String not found' });
  assert.deepEqual(toolOutput(failed), [{ type: 'content', content: { type: 'text', text: 'String not found' } }]);
  assert.deepEqual([toolKind(item('ExitPlanMode', { type: 'plan', text: '1. Fix' })), toolTitle(item('Task', { type: 'sub_agent', subAgentType: 'Explore', description: 'Find it' }))], ['think', 'Explore: Find it']);
  // A detail type later than this version: as unknown.
  const later = item('Screenshot', { type: 'image', input: { path: '/tmp/s.png' }, output: 'saved' });
  assert.deepEqual([toolKind(later), toolTitle(later), toolOutput(later)[0].content.text, toolInput(later), toolLocations(later)], ['other', 'Screenshot {"path":"/tmp/s.png"}', 'saved', { path: '/tmp/s.png' }, undefined]);
  // Shell and ALP's tools as before, older Claude `Read {…}` commands included.
  const shell = item('shell', { type: 'shell', command: 'Read {"file_path":"/p/a.ts"}', output: 'x' });
  assert.deepEqual([toolKind(shell), toolTitle(shell), toolInput(shell)], ['read', 'Read {"file_path":"/p/a.ts"}', { command: 'Read {"file_path":"/p/a.ts"}', cwd: undefined }]);
  const delegate = item('alp_delegate', { type: 'unknown', input: { agent: 'peer', task: 'Fix it' }, output: null });
  assert.deepEqual([toolKind(delegate), toolTitle(delegate)], ['other', 'Delegate to peer: Fix it']);
  // `alp run`'s one line per finished call.
  assert.deepEqual([read, edit, web, delegate, shell, later].map(toolLine), ['Read /p/src/a.ts', 'Edit /p/a.ts', 'WebSearch acp', 'delegate → peer', 'Read {"file_path":"/p/a.ts"}', 'Screenshot']);
});
