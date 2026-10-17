// t-7679.13: typed tool-call details. Each runtime's tool calls reach viewers as read / edit / write /
// search / fetch / sub_agent / plan / plain_text details instead of `shell` or `unknown`, within the
// protocol's bounds; the command strings skill use, copy escapes and the supervisor's journal read stay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '@anhlp/alp-core/init';
import {
  acpToolDetail, antigravityToolDetail, boundDetail, claudeToolDetail, clipText, codexToolCall, stripReadGutter, toolError,
  ClaudeTransport, createAlpRuntime, DETAIL_FILE_PATHS, DETAIL_TEXT_CHARS, DETAIL_WEB_RESULTS, ERROR_CHARS, SKILL_PLUGIN,
} from '@anhlp/alp-runtime';

async function until(check, what = 'condition') {
  for (let i = 0; i < 600; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(`Expected ${what} did not arrive`);
}

test('Claude tools become typed details; Bash stays a shell command', () => {
  assert.equal(claudeToolDetail('Bash', { command: 'npm test' }), undefined);
  // Running: what the input says.
  assert.deepEqual(claudeToolDetail('Read', { file_path: '/p/src/a.ts', offset: 10, limit: 5 }), { type: 'read', filePath: '/p/src/a.ts', offset: 10, limit: 5 });
  // Done: the gutter of Claude's numbered text is stripped, its first number the offset; a trailing reminder goes.
  assert.deepEqual(
    claudeToolDetail('Read', { file_path: '/p/a.ts' }, { text: '     7\tconst a = 1;\n     8→\tconst b = 2;\n\n<system-reminder>\nmalware?\n</system-reminder>\n' }),
    { type: 'read', filePath: '/p/a.ts', content: 'const a = 1;\n\tconst b = 2;', offset: 7 },
  );
  // The SDK's structured output wins over the text.
  assert.deepEqual(
    claudeToolDetail('Read', { file_path: '/p/a.ts' }, { text: '     1\tx', structured: { type: 'text', file: { filePath: '/p/a.ts', content: 'x\n', startLine: 1, numLines: 1, totalLines: 1 } } }),
    { type: 'read', filePath: '/p/a.ts', content: 'x\n', offset: 1 },
  );
  assert.deepEqual(claudeToolDetail('Write', { file_path: '/p/n.md', content: '# N\n' }, { text: 'File created' }), { type: 'write', filePath: '/p/n.md', content: '# N\n' });
  assert.deepEqual(
    claudeToolDetail('Edit', { file_path: '/p/a.ts', old_string: 'a = 1', new_string: 'a = 2' }, { text: 'ok', structured: { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a = 1', '+a = 2'] }] } }),
    { type: 'edit', filePath: '/p/a.ts', oldString: 'a = 1', newString: 'a = 2', unifiedDiff: '@@ -1,1 +1,1 @@\n-a = 1\n+a = 2\n' },
  );
  assert.deepEqual(
    claudeToolDetail('MultiEdit', { file_path: '/p/a.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] }),
    { type: 'edit', filePath: '/p/a.ts', unifiedDiff: '@@\n-a\n+b\n@@\n-c\n+d\n' },
  );
  assert.deepEqual(claudeToolDetail('NotebookEdit', { notebook_path: '/p/n.ipynb', new_source: 'print(1)', cell_id: 'c1' }), { type: 'edit', filePath: '/p/n.ipynb', newString: 'print(1)' });
  assert.deepEqual(
    claudeToolDetail('Grep', { pattern: 'TODO', path: 'src' }, { text: 'Found 1 file', structured: { mode: 'files_with_matches', numFiles: 1, filenames: ['src/a.ts'] } }),
    { type: 'search', query: 'TODO', toolName: 'grep', filePaths: ['src/a.ts'], numFiles: 1 },
  );
  assert.deepEqual(claudeToolDetail('Grep', { pattern: 'TODO' }, { text: 'src/a.ts:1:// TODO' }), { type: 'search', query: 'TODO', toolName: 'grep', content: 'src/a.ts:1:// TODO' });
  assert.deepEqual(
    claudeToolDetail('Glob', { pattern: '**/*.ts' }, { text: 'a.ts', structured: { durationMs: 3, numFiles: 2, filenames: ['a.ts', 'b.ts'], truncated: false } }),
    { type: 'search', query: '**/*.ts', toolName: 'glob', filePaths: ['a.ts', 'b.ts'], numFiles: 2, truncated: false },
  );
  assert.deepEqual(
    claudeToolDetail('WebFetch', { url: 'https://x.dev', prompt: 'Sum it' }, { text: 'Sum', structured: { bytes: 9, code: 200, codeText: 'OK', result: 'Summary', durationMs: 5, url: 'https://x.dev' } }),
    { type: 'fetch', url: 'https://x.dev', prompt: 'Sum it', result: 'Summary', code: 200 },
  );
  assert.deepEqual(
    claudeToolDetail('WebSearch', { query: 'acp spec' }, { text: 'x', structured: { query: 'acp spec', results: [{ tool_use_id: 's', content: [{ title: 'ACP', url: 'https://agentclientprotocol.com' }] }, 'One result.'], durationSeconds: 1 } }),
    { type: 'search', query: 'acp spec', toolName: 'web_search', webResults: [{ title: 'ACP', url: 'https://agentclientprotocol.com' }], content: 'One result.' },
  );
  assert.deepEqual(
    claudeToolDetail('Task', { subagent_type: 'Explore', description: 'Find the parser', prompt: 'Look for…' }, { text: 'raw', structured: { agentId: 'a', content: [{ type: 'text', text: 'It is in src/p.ts' }] } }),
    { type: 'sub_agent', subAgentType: 'Explore', description: 'Find the parser', log: 'It is in src/p.ts' },
  );
  assert.equal(claudeToolDetail('Agent', { description: 'x' }).type, 'sub_agent');
  assert.deepEqual(claudeToolDetail('ExitPlanMode', { plan: '1. Read\n2. Fix' }), { type: 'plan', text: '1. Read\n2. Fix' });
  assert.deepEqual(claudeToolDetail('Skill', { skill: 'alp:xia' }, { text: 'Launching skill: alp:xia' }), { type: 'plain_text', label: 'alp:xia', text: 'Launching skill: alp:xia' });
  assert.deepEqual(
    claudeToolDetail('TodoWrite', { todos: [{ content: 'Write tests', status: 'completed' }, { content: 'Fix', status: 'in_progress' }, { content: 'Ship', status: 'pending' }] }),
    { type: 'plain_text', label: 'Todos', text: '[x] Write tests\n[~] Fix\n[ ] Ship' },
  );
  // MCP tools, ALP's own included, and tools ALP does not type: their raw input and output.
  assert.deepEqual(claudeToolDetail('mcp__alp__alp_board', { kinds: ['claim'] }, { text: '{"pins":[]}' }), { type: 'unknown', input: { kinds: ['claim'] }, output: '{"pins":[]}' });
  assert.deepEqual(claudeToolDetail('LS', { path: '/p' }), { type: 'unknown', input: { path: '/p' }, output: null });
  // Without the field its type needs, a call is unknown rather than an invalid typed one.
  assert.deepEqual(claudeToolDetail('Edit', { new_string: 'x' }), { type: 'unknown', input: { new_string: 'x' }, output: null });
  // A failed call keeps its typed input; the error text is the item's, not the content.
  assert.deepEqual(claudeToolDetail('Read', { file_path: '/p/gone' }, { text: 'File does not exist.', error: true }), { type: 'read', filePath: '/p/gone' });
});

test('the gutter is stripped only from text numbered from its first line', () => {
  assert.equal(stripReadGutter('const a = 1;\n2\tb'), undefined);
  assert.equal(stripReadGutter('1\ta\n3\tb'), undefined);
  assert.deepEqual(stripReadGutter('  41\ta\n  42\tb'), { content: 'a\nb', startLine: 41 });
  // Every non-empty line must carry it.
  assert.equal(stripReadGutter('1\ta\nplain\n3\tc'), undefined);
  assert.deepEqual(stripReadGutter('     9→x\n    10→\n    11→y\n'), { content: 'x\n\ny\n', startLine: 9 });
  // The first line's number is the offset, over the input's.
  assert.equal(claudeToolDetail('Read', { file_path: '/p/a.ts', offset: 5 }, { text: '     7\tx' }).offset, 7);
  assert.equal(claudeToolDetail('Read', { file_path: '/p/a.ts', offset: 5 }).offset, 5);
});

test('typed details are bounded: 65,536 characters a string, 200 paths, 50 web results; errors 2,000; shell and unknown pass', () => {
  const long = 'x'.repeat(DETAIL_TEXT_CHARS + 10);
  assert.equal(clipText(long), `${'x'.repeat(DETAIL_TEXT_CHARS)}\n… (10 more characters)`);
  // Bounding twice keeps the first count.
  assert.equal(clipText(clipText(long)), clipText(long));
  const big = boundDetail({ type: 'read', filePath: '/p/a', content: 'y'.repeat(DETAIL_TEXT_CHARS + 4464) });
  assert.deepEqual(boundDetail(big), big);
  assert.ok(big.content.endsWith('… (4464 more characters)'));
  // A surrogate pair is never split.
  const emoji = `${'a'.repeat(DETAIL_TEXT_CHARS - 1)}😀tail`;
  assert.ok(clipText(emoji).startsWith(`${'a'.repeat(DETAIL_TEXT_CHARS - 1)}\n…`));
  const read = claudeToolDetail('Read', { file_path: '/p/big.txt' }, { text: long });
  assert.equal(read.content.length, DETAIL_TEXT_CHARS + '\n… (10 more characters)'.length);
  const paths = Array.from({ length: 250 }, (_, i) => `f${i}.ts`);
  const glob = claudeToolDetail('Glob', { pattern: '*' }, { structured: { durationMs: 1, numFiles: 250, filenames: paths, truncated: false } });
  assert.equal(glob.filePaths.length, DETAIL_FILE_PATHS);
  assert.equal(glob.truncated, true);
  const hits = Array.from({ length: 60 }, (_, i) => ({ title: `t${i}`, url: `https://x.dev/${i}` }));
  const search = claudeToolDetail('WebSearch', { query: 'q' }, { structured: { query: 'q', results: [{ tool_use_id: 's', content: hits }], durationSeconds: 1 } });
  assert.equal(search.webResults.length, DETAIL_WEB_RESULTS);
  assert.equal(toolError('e'.repeat(ERROR_CHARS + 5)), `${'e'.repeat(ERROR_CHARS)}\n… (5 more characters)`);
  assert.equal(toolError(''), 'Tool call failed');
  assert.equal(toolError('<tool_use_error>File does not exist.</tool_use_error>'), 'File does not exist.');
  assert.equal(toolError(undefined), 'Tool call failed');
  const shell = { type: 'shell', command: long, output: long };
  assert.equal(boundDetail(shell), shell);
  const unknown = { type: 'unknown', input: long, output: long };
  assert.equal(boundDetail(unknown), unknown);
});

test('ACP tool calls are typed by their kind; execute stays a shell command', () => {
  assert.equal(acpToolDetail({ kind: 'execute', rawInput: { command: 'ls' } }), undefined);
  assert.deepEqual(acpToolDetail({ kind: 'read', title: 'Read a.ts', locations: [{ path: '/p/a.ts', line: 3 }], content: [{ type: 'content', content: { type: 'text', text: 'const a = 1;' } }] }), { type: 'read', filePath: '/p/a.ts', content: 'const a = 1;', offset: 3 });
  assert.deepEqual(acpToolDetail({ kind: 'read', rawInput: { path: '/p/b.ts' } }), { type: 'read', filePath: '/p/b.ts' });
  assert.deepEqual(acpToolDetail({ kind: 'edit', content: [{ type: 'diff', path: '/p/a.ts', oldText: 'a = 1', newText: 'a = 2' }] }), { type: 'edit', filePath: '/p/a.ts', oldString: 'a = 1', newString: 'a = 2' });
  // A diff without old text creates the file.
  assert.deepEqual(acpToolDetail({ kind: 'edit', content: [{ type: 'diff', path: '/p/new.md', oldText: null, newText: '# New' }] }), { type: 'write', filePath: '/p/new.md', content: '# New' });
  assert.deepEqual(acpToolDetail({ kind: 'edit', locations: [{ path: '/p/a.ts' }], rawInput: { old_string: 'x', new_string: 'y' } }), { type: 'edit', filePath: '/p/a.ts', oldString: 'x', newString: 'y' });
  assert.deepEqual(acpToolDetail({ kind: 'delete', locations: [{ path: '/p/old.ts' }] }), { type: 'edit', filePath: '/p/old.ts' });
  assert.deepEqual(acpToolDetail({ kind: 'move', title: 'Rename', locations: [{ path: '/p/a.ts' }, { path: '/p/b.ts' }] }), { type: 'plain_text', label: 'Rename', text: '/p/a.ts → /p/b.ts' });
  assert.deepEqual(acpToolDetail({ kind: 'search', rawInput: { pattern: 'TODO' }, locations: [{ path: '/p/a.ts' }], content: [{ type: 'content', content: { type: 'text', text: '1 match' } }] }), { type: 'search', query: 'TODO', toolName: 'search', content: '1 match', filePaths: ['/p/a.ts'] });
  assert.deepEqual(acpToolDetail({ kind: 'fetch', rawInput: { url: 'https://x.dev' }, content: [{ type: 'content', content: { type: 'text', text: 'page' } }] }), { type: 'fetch', url: 'https://x.dev', result: 'page' });
  assert.deepEqual(acpToolDetail({ kind: 'fetch', rawInput: { query: 'acp' } }), { type: 'search', query: 'acp', toolName: 'web_search' });
  assert.deepEqual(acpToolDetail({ kind: 'think', title: 'Plan', content: [{ type: 'content', content: { type: 'text', text: 'First…' } }] }), { type: 'plain_text', label: 'Plan', text: 'First…' });
  assert.deepEqual(acpToolDetail({ kind: 'other', title: 'mcp tool', rawInput: { a: 1 }, rawOutput: { b: 2 } }), { type: 'unknown', input: { a: 1 }, output: { b: 2 } });
  // Read without any path: unknown, never a typed detail without its filePath.
  assert.deepEqual(acpToolDetail({ kind: 'read', title: 'Read' }), { type: 'unknown', input: null, output: null });
});

test('Antigravity tool steps are typed from their tool_info', () => {
  assert.deepEqual(antigravityToolDetail({ name: 'run_command', parameters: { CommandLine: 'npm test', Cwd: '/p' }, output: 'ok' }), { type: 'shell', command: 'npm test', cwd: '/p', output: 'ok' });
  assert.deepEqual(antigravityToolDetail({ name: 'view_file', parameters: { AbsolutePath: '/p/a.ts', StartLine: 3, EndLine: 7 }, output: 'code' }), { type: 'read', filePath: '/p/a.ts', content: 'code', offset: 3, limit: 5 });
  assert.deepEqual(antigravityToolDetail({ name: 'write_to_file', parameters: { TargetFile: '/p/n.md', CodeContent: '# N' } }), { type: 'write', filePath: '/p/n.md', content: '# N' });
  assert.deepEqual(antigravityToolDetail({ name: 'replace_file_content', parameters: { TargetFile: '/p/a.ts', TargetContent: 'a', ReplacementContent: 'b' } }), { type: 'edit', filePath: '/p/a.ts', oldString: 'a', newString: 'b' });
  assert.deepEqual(antigravityToolDetail({ name: 'multi_replace_file_content', parameters: { TargetFile: '/p/a.ts' } }), { type: 'edit', filePath: '/p/a.ts' });
  assert.deepEqual(antigravityToolDetail({ name: 'grep_search', parameters: { Query: 'x' }, output: 'hits' }), { type: 'unknown', input: { Query: 'x' }, output: 'hits' });
  assert.deepEqual(antigravityToolDetail({ name: 'view_file', parameters: {}, error: { type: 'x', message: 'no path' } }), { type: 'unknown', input: {}, output: 'no path' });
});

test('Codex native file changes, web searches, MCP calls and sub-agents become tool calls', () => {
  const one = codexToolCall({ type: 'fileChange', id: 'f1', status: 'completed', changes: [{ path: '/p/a.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1 @@\n-a\n+b\n' }] }, true);
  assert.deepEqual(one, { name: 'apply_patch', status: 'completed', detail: { type: 'edit', filePath: '/p/a.ts', unifiedDiff: '@@ -1 +1 @@\n-a\n+b\n' } });
  assert.deepEqual(codexToolCall({ type: 'fileChange', id: 'f2', status: 'inProgress', changes: [{ path: '/p/n.md', kind: { type: 'add' }, diff: '# New\n' }] }, false), { name: 'apply_patch', status: 'running', detail: { type: 'write', filePath: '/p/n.md', content: '# New\n' } });
  // Codex reports a deleted or added file's content, not a diff: it becomes one hunk.
  assert.deepEqual(codexToolCall({ type: 'fileChange', id: 'f3', status: 'completed', changes: [{ path: '/p/old.ts', kind: { type: 'delete' }, diff: 'gone\n-x\n' }] }, true).detail, { type: 'edit', filePath: '/p/old.ts', unifiedDiff: '@@ -1,2 +0,0 @@\n-gone\n--x\n' });
  assert.deepEqual(
    codexToolCall({ type: 'fileChange', id: 'f5', status: 'completed', changes: [{ path: 'n.md', kind: { type: 'add' }, diff: '# N\nx' }, { path: 'old.ts', kind: { type: 'delete' }, diff: 'gone\n' }] }, true).detail,
    { type: 'edit', filePath: 'n.md', unifiedDiff: '--- a/n.md\n+++ b/n.md\n@@ -0,0 +1,2 @@\n+# N\n+x\n--- a/old.ts\n+++ b/old.ts\n@@ -1,1 +0,0 @@\n-gone\n' },
  );
  // Content with a diff-like line inside (a deleted .patch file) is still content.
  assert.equal(codexToolCall({ type: 'fileChange', id: 'f6', status: 'completed', changes: [{ path: 'a.patch', kind: { type: 'delete' }, diff: 'notes\n--- x\n' }] }, true).detail.unifiedDiff, '@@ -1,2 +0,0 @@\n-notes\n---- x\n');
  // A removed `-- x` line inside a file's hunk is not that file's header.
  assert.equal(
    codexToolCall({ type: 'fileChange', id: 'f8', status: 'completed', changes: [{ path: 'a.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b\n' }, { path: 'q.sql', kind: { type: 'delete' }, diff: '-- comment\nselect 1\n' }] }, true).detail.unifiedDiff,
    '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n--- a/q.sql\n+++ b/q.sql\n@@ -1,2 +0,0 @@\n--- comment\n-select 1\n',
  );
  // An update's diff passes as it is.
  assert.equal(codexToolCall({ type: 'fileChange', id: 'f7', status: 'completed', changes: [{ path: 'a.ts', kind: { type: 'update' }, diff: 'x\n' }] }, true).detail.unifiedDiff, 'x\n');
  assert.deepEqual(
    codexToolCall({ type: 'fileChange', id: 'f4', status: 'declined', changes: [{ path: 'a.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b' }, { path: 'b.ts', kind: { type: 'update' }, diff: '--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-c\n+d\n' }] }, true),
    { name: 'apply_patch', status: 'failed', error: 'Tool call failed', detail: { type: 'edit', filePath: 'a.ts', unifiedDiff: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-c\n+d\n' } },
  );
  assert.deepEqual(codexToolCall({ type: 'webSearch', id: 'w1', query: 'acp spec' }, false), { name: 'web_search', status: 'running', detail: { type: 'search', query: 'acp spec', toolName: 'web_search' } });
  assert.equal(codexToolCall({ type: 'webSearch', id: 'w1', query: 'acp spec' }, true).status, 'completed');
  assert.deepEqual(
    codexToolCall({ type: 'mcpToolCall', id: 'm1', server: 'docs', tool: 'lookup', status: 'failed', arguments: { q: 'x' }, result: null, error: { message: 'server down' } }, true),
    { name: 'mcp__docs__lookup', status: 'failed', error: 'server down', detail: { type: 'unknown', input: { q: 'x' }, output: null } },
  );
  assert.deepEqual(codexToolCall({ type: 'collabAgentToolCall', id: 'c1', status: 'inProgress', tool: 'spawnAgent', prompt: 'Review the diff' }, false), { name: 'Sub-agent', status: 'running', detail: { type: 'sub_agent', subAgentType: 'Sub-agent', description: 'Review the diff' } });
  assert.equal(codexToolCall({ type: 'reasoning', id: 'r1' }, true), undefined);
});

test('ClaudeTransport keeps its command strings and attaches the typed detail, running and done', () => {
  const transport = new ClaudeTransport(process.execPath, tmpdir(), process.env);
  const seen = [];
  transport.onNotification((method, params) => method.startsWith('item/') && seen.push([method, params.item]));
  transport.activeTurn = 'turn-1';
  transport.handle({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [
    { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/p/a.ts' } },
    { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } },
  ] } });
  transport.handle({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '     1\tconst a = 1;' }] }] }, tool_use_result: { type: 'text', file: { filePath: '/p/a.ts', content: 'const a = 1;\n', startLine: 1 } } });
  transport.handle({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'boom', is_error: true }] } });
  assert.deepEqual(seen.map(([method, item]) => [method, item.id, item.command, item.status, item.tool, item.detail]), [
    ['item/started', 't1', 'Read {"file_path":"/p/a.ts"}', 'inProgress', 'Read', { type: 'read', filePath: '/p/a.ts' }],
    ['item/started', 't2', 'npm test', 'inProgress', undefined, undefined],
    ['item/completed', 't1', 'Read {"file_path":"/p/a.ts"}', 'completed', 'Read', { type: 'read', filePath: '/p/a.ts', content: 'const a = 1;\n', offset: 1 }],
    ['item/completed', 't2', 'npm test', 'failed', undefined, undefined],
  ]);
  // The output a shell view showed before is unchanged.
  assert.equal(seen[2][1].aggregatedOutput, '[{"type":"text","text":"     1\\tconst a = 1;"}]');
  // A failed typed call carries the tool's error text.
  transport.handle({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm2', content: [{ type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: '/p/a.ts', old_string: 'x', new_string: 'y' } }] } });
  transport.handle({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', content: 'String to replace not found in file.', is_error: true }] } });
  assert.equal(seen.at(-1)[1].error, 'String to replace not found in file.');
});

let calls = 0;
function fakeTransport(runtimes) {
  return (cwd, env, kind) => {
    const index = runtimes.length;
    let turns = 0;
    const runtime = {
      kind, calls: [], threadId: `thread-${index}`, turnId: undefined,
      async initialize() {},
      onNotification(fn) { this.notification = fn; }, onFailure(fn) { this.failure = fn; }, onRequest(fn) { this.serverRequest = fn; },
      async close() { this.closed = true; },
      async request(method, params) {
        this.calls.push({ method, params });
        if (method.startsWith('thread/')) return { thread: { id: this.threadId } };
        if (method === 'turn/start') { this.turnId = `turn-${index}-${++turns}`; return { turn: { id: this.turnId } }; }
        return {};
      },
      get started() { return this.calls.filter(call => call.method === 'turn/start'); },
      get config() { return this.calls.find(call => call.method === 'thread/start')?.params; },
      item(method, item) { this.notification(method, { threadId: this.threadId, item }); },
      finish(text = 'done') {
        this.notification('item/completed', { threadId: this.threadId, item: { type: 'agentMessage', id: `output-${index}-${turns}-${++calls}`, text } });
        this.notification('turn/completed', { threadId: this.threadId, turn: { id: this.turnId, status: 'completed' } });
      },
    };
    runtimes.push(runtime);
    return runtime;
  };
}

test('the runtime emits typed tool calls, while skill use and the supervisor\'s journal still read the command', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-tool-detail-'));
  let runtime;
  t.after(async () => { await runtime?.shutdown(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const root = path.join(directory, 'project');
  const runs = path.join(directory, 'runs');
  await initProject(root);
  const runtimes = [];
  runtime = createAlpRuntime({ language: 'English', transport: fakeTransport(runtimes), libraryDir: path.join(directory, 'home'), runLogDir: runs });
  const events = [];
  runtime.onEvent(envelope => envelope.event.type === 'item' && envelope.event.item.kind === 'tool_call' && events.push(envelope.event.item));
  await runtime.open('root', { cwd: root, model: 'claude:claude-opus-5-5' });
  await until(() => runtimes.length === 2 && runtimes[1].config, 'the supervisor');
  const [main, supervisor] = runtimes;
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Read it' }] });

  // Claude's Read, as its transport reports it: the command as before, the typed detail beside it.
  const read = { type: 'commandExecution', id: 'r1', command: 'Read {"file_path":"/p/a.ts"}', cwd: root, aggregatedOutput: '', tool: 'Read' };
  main.item('item/started', { ...read, status: 'inProgress', detail: { type: 'read', filePath: '/p/a.ts' } });
  main.item('item/completed', { ...read, status: 'completed', exitCode: 0, aggregatedOutput: 'x', detail: { type: 'read', filePath: '/p/a.ts', content: 'x', offset: 1 } });
  // Claude's Skill tool: a plain_text detail, and still a logged skill use.
  const skill = `Skill {"skill":"${SKILL_PLUGIN}:xia"}`;
  main.item('item/started', { type: 'commandExecution', id: 's1', command: skill, cwd: root, status: 'inProgress', aggregatedOutput: '', tool: 'Skill', detail: { type: 'plain_text', label: `${SKILL_PLUGIN}:xia` } });
  // A failed typed call with its error text, and one without.
  main.item('item/completed', { type: 'commandExecution', id: 'e1', command: 'Edit {"file_path":"/p/a.ts"}', cwd: root, status: 'failed', exitCode: 1, aggregatedOutput: 'nope', tool: 'Edit', detail: { type: 'edit', filePath: '/p/a.ts' }, error: 'String to replace not found' });
  main.item('item/completed', { type: 'commandExecution', id: 'e2', command: 'Write {"file_path":"/p/b.ts"}', cwd: root, status: 'failed', exitCode: 1, aggregatedOutput: '', tool: 'Write', detail: { type: 'write', filePath: '/p/b.ts' } });
  // A running call that learned more (an ACP call's path): an update, not a new start.
  main.item('item/updated', { type: 'commandExecution', id: 'a1', command: 'read: Read', cwd: root, status: 'inProgress', aggregatedOutput: '', tool: 'Read', detail: { type: 'read', filePath: '/p/c.ts' } });
  // A plain command: shell exactly as before.
  main.item('item/completed', { type: 'commandExecution', id: 'b1', command: 'npm test', cwd: root, status: 'failed', exitCode: 1, aggregatedOutput: 'fail' });
  // Codex's own items, dropped before.
  main.item('item/started', { type: 'fileChange', id: 'f1', status: 'inProgress', changes: [{ path: '/p/a.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b\n' }] });
  main.item('item/completed', { type: 'webSearch', id: 'w1', query: 'acp spec' });
  main.finish('Read it');

  await until(() => supervisor.started.length === 1, 'the review');
  const last = id => events.filter(item => item.id === id).at(-1);
  assert.deepEqual(last('r1'), { kind: 'tool_call', id: 'r1', callId: 'r1', name: 'Read', status: 'completed', detail: { type: 'read', filePath: '/p/a.ts', content: 'x', offset: 1 } });
  assert.deepEqual(events.find(item => item.id === 'r1'), { kind: 'tool_call', id: 'r1', callId: 'r1', name: 'Read', status: 'running', detail: { type: 'read', filePath: '/p/a.ts' } });
  assert.deepEqual([last('s1').name, last('s1').detail], ['Skill', { type: 'plain_text', label: `${SKILL_PLUGIN}:xia` }]);
  assert.deepEqual([last('e1').status, last('e1').error], ['failed', 'String to replace not found']);
  assert.equal(last('e2').error, 'Tool call failed');
  assert.deepEqual([last('a1').status, last('a1').detail], ['running', { type: 'read', filePath: '/p/c.ts' }]);
  assert.deepEqual(last('b1'), { kind: 'tool_call', id: 'b1', callId: 'b1', name: 'shell', status: 'failed', error: 'Command failed', detail: { type: 'shell', command: 'npm test', cwd: root, output: 'fail', exitCode: 1 } });
  assert.deepEqual(last('f1'), { kind: 'tool_call', id: 'f1', callId: 'f1', name: 'apply_patch', status: 'running', detail: { type: 'edit', filePath: '/p/a.ts', unifiedDiff: '@@ -1 +1 @@\n-a\n+b\n' } });
  assert.deepEqual(last('w1'), { kind: 'tool_call', id: 'w1', callId: 'w1', name: 'web_search', status: 'completed', detail: { type: 'search', query: 'acp spec', toolName: 'web_search' } });

  // The journal still reads Claude's tools as commands.
  const digest = supervisor.started[0].params.input.at(-1).text;
  assert.match(digest, /main shell completed \(exit 0\): Read \{"file_path":"\/p\/a\.ts"\}/);
  assert.match(digest, /main shell failed \(exit 1\): npm test/);
  const runLog = async () => (await readFile(path.join(runs, 'root.jsonl'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  await until(async () => (await runLog()).some(entry => entry.event === 'skill'), 'the skill use');
  assert.deepEqual((await runLog()).filter(entry => entry.event === 'skill').map(entry => [entry.skill, entry.via]), [['xia', 'skill']]);
});
