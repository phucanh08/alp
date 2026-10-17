// Tool calls in the stream (src/lib/tool-calls.js): the collapsed row per detail type as Paseo's
// tool-call-display.ts, paths relative to the workspace, unified diffs with line numbers, a
// bounded line diff, clipping and links.
import test from 'node:test';
import assert from 'node:assert/strict';
import { clipLines, detailKind, diffStats, editDiff, humanizeToolName, lineDiff, parseUnifiedDiff, presentToolCall, relativePath, safeLink, splitLines } from '../src/lib/tool-calls.js';

const roots = ['/home/me/project', '/private/home/me/project'];
const row = (name, detail) => {
  const { label, secondary, icon, kind } = presentToolCall({ name, detail }, roots);
  return { kind, label, secondary, icon };
};

test('the collapsed row per detail type follows Paseo', () => {
  assert.deepEqual(row('shell', { type: 'shell', command: 'npm test\n--watch', output: '' }), { kind: 'shell', label: 'Shell', secondary: 'npm test', icon: 'terminal' });
  assert.deepEqual(row('Read', { type: 'read', filePath: '/home/me/project/src/a.ts', content: 'x' }), { kind: 'read', label: 'Read', secondary: 'src/a.ts', icon: 'eye' });
  assert.deepEqual(row('apply_patch', { type: 'edit', filePath: '/private/home/me/project/b.ts' }), { kind: 'edit', label: 'Edit', secondary: 'b.ts', icon: 'pencil' });
  assert.deepEqual(row('Write', { type: 'write', filePath: '/elsewhere/c.ts' }), { kind: 'write', label: 'Write', secondary: '/elsewhere/c.ts', icon: 'pencil' });
  assert.deepEqual(row('web_search', { type: 'search', query: 'paseo diff viewer', toolName: 'web_search' }), { kind: 'search', label: 'Search', secondary: 'paseo diff viewer', icon: 'search' });
  assert.deepEqual(row('WebFetch', { type: 'fetch', url: 'https://example.com/a' }), { kind: 'fetch', label: 'Fetch', secondary: 'https://example.com/a', icon: 'search' });
  assert.deepEqual(row('Task', { type: 'sub_agent', subAgentType: 'Explore', description: 'Find the parser\nmore' }), { kind: 'sub_agent', label: 'Explore', secondary: 'Find the parser', icon: 'bot' });
  assert.deepEqual(row('Sub-agent', { type: 'sub_agent' }), { kind: 'sub_agent', label: 'Task', secondary: '', icon: 'bot' });
  assert.deepEqual(row('ExitPlanMode', { type: 'plan', text: '# Plan' }), { kind: 'plan', label: 'Plan', secondary: '', icon: 'brain' });
  assert.deepEqual(row('skill', { type: 'plain_text', label: 'Skill output', text: 'done' }), { kind: 'plain_text', label: 'Skill', secondary: 'Skill output', icon: 'wrench' });
});

test('calls without a typed detail keep their rows: ALP tools, MCP tools, humanized names', () => {
  assert.deepEqual(row('alp_delegate', { type: 'unknown', input: { agent: 'peer', brief: 'x' }, output: null }), { kind: 'unknown', label: 'Delegate', secondary: 'to peer', icon: 'bot' });
  assert.deepEqual(row('alp_delegate', { type: 'unknown', input: null, output: null }), { kind: 'unknown', label: 'Delegate', secondary: 'to an agent', icon: 'bot' });
  assert.deepEqual(row('alp_ask', { type: 'unknown', input: { question: 'Deploy?\nreally', options: [] }, output: null }), { kind: 'unknown', label: 'Ask', secondary: 'Deploy?', icon: 'wrench' });
  assert.deepEqual(row('mcp__github__get_issue', { type: 'unknown', input: { repo: 'a/b' }, output: {} }), { kind: 'unknown', label: 'mcp__github__get_issue', secondary: 'a/b', icon: 'wrench' });
  assert.equal(row('todo_write', { type: 'unknown', input: null, output: null }).label, 'Todo write');
  assert.equal(humanizeToolName(''), 'Tool');
  assert.equal(humanizeToolName('server.tool'), 'server.tool');
});

test('a detail type this build does not know renders as unknown', () => {
  assert.equal(detailKind({ type: 'worktree_setup', branchName: 'x' }), 'unknown');
  assert.equal(detailKind(undefined), 'unknown');
  assert.equal(detailKind({ type: 'edit' }), 'edit');
  assert.deepEqual(row('worktree', { type: 'worktree_setup', input: 'feature/x' }), { kind: 'unknown', label: 'Worktree', secondary: 'feature/x', icon: 'wrench' });
});

test('paths: relative inside a root, "." for the root, as given elsewhere', () => {
  assert.equal(relativePath('/home/me/project/src/a.ts', ['/home/me/project/']), 'src/a.ts');
  assert.equal(relativePath('/home/me/project', ['/home/me/project']), '.');
  assert.equal(relativePath('/home/me/projectile/a.ts', ['/home/me/project']), '/home/me/projectile/a.ts');
  assert.equal(relativePath('C:\\w\\src\\a.ts', ['C:\\w']), 'src/a.ts');
  assert.equal(relativePath('src/a.ts', [undefined, '']), 'src/a.ts');
});

test('unified diff: line numbers from the hunk, headers dropped, "-- x" lines inside a hunk stay removals', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1..2 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -10,4 +10,4 @@ function f() {',
    ' keep',
    '--- old comment',
    '+++ new comment',
    ' keep 2',
    '\\ No newline at end of file',
    ' last',
  ].join('\n');
  const lines = parseUnifiedDiff(diff);
  assert.deepEqual(lines, [
    { type: 'hunk', text: '@@ -10,4 +10,4 @@ function f() {' },
    { type: 'context', text: 'keep', oldLine: 10, newLine: 10 },
    { type: 'remove', text: '-- old comment', oldLine: 11 },
    { type: 'add', text: '++ new comment', newLine: 11 },
    { type: 'context', text: 'keep 2', oldLine: 12, newLine: 12 },
    { type: 'meta', text: '\\ No newline at end of file' },
    { type: 'context', text: 'last', oldLine: 13, newLine: 13 },
  ]);
  assert.deepEqual(diffStats(lines), { added: 1, removed: 1 });
  assert.equal(editDiff({ unifiedDiff: diff }).numbered, true);
});

test('unified diff of several files: a file line before each; a new file; no hunk header', () => {
  const diff = '--- a/one.ts\n+++ b/one.ts\n@@ -1 +1 @@\n-a\n+b\n--- /dev/null\n+++ b/two.ts\n@@ -0,0 +1,2 @@\n+x\n+y\n';
  const lines = parseUnifiedDiff(diff);
  assert.deepEqual(lines.filter(line => line.type === 'file').map(line => line.text), ['one.ts', 'two.ts']);
  assert.equal(lines[0].type, 'file');
  assert.deepEqual(lines.filter(line => line.type === 'add').map(line => line.newLine), [1, 1, 2]);
  // One file: no file line (the row already names it).
  assert.equal(parseUnifiedDiff('--- a/one.ts\n+++ b/one.ts\n@@ -1 +1 @@\n-a\n+b').some(line => line.type === 'file'), false);
  // Bare +/- lines (no @@): read by the first character, without numbers.
  const bare = editDiff({ unifiedDiff: '-old\n+new\n same' });
  assert.equal(bare.numbered, false);
  assert.deepEqual(bare.lines.map(line => line.type), ['remove', 'add', 'context']);
});

test('line diff of two strings: the longest common subsequence, with each side numbered', () => {
  const { lines, exact } = lineDiff('a\nb\nc\nd\n', 'a\nB\nc\nd\ne\n');
  assert.equal(exact, true);
  assert.deepEqual(lines.map(line => `${line.type}:${line.text}:${line.oldLine ?? ''}:${line.newLine ?? ''}`), [
    'context:a:1:1', 'remove:b:2:', 'add:B::2', 'context:c:3:3', 'context:d:4:4', 'add:e::5',
  ]);
  assert.deepEqual(lineDiff('', '').lines, []);
  assert.deepEqual(lineDiff('', 'x').lines, [{ type: 'add', text: 'x', newLine: 1 }]);
  const edit = editDiff({ oldString: 'x\ny', newString: 'x\nz' });
  assert.equal(edit.numbered, false, 'fragments of a file: their numbers are not the file\'s');
  assert.deepEqual(diffStats(edit.lines), { added: 1, removed: 1 });
});

test('line diff stays bounded: a huge edit falls back to removals then additions', () => {
  const before = Array.from({ length: 3000 }, (_, i) => `old ${i}`).join('\n');
  const after = Array.from({ length: 3000 }, (_, i) => `new ${i}`).join('\n');
  const started = Date.now();
  const { lines, exact } = lineDiff(`same\n${before}\nend`, `same\n${after}\nend`);
  assert.ok(Date.now() - started < 1000, 'no quadratic table for 3000×3000 lines');
  assert.equal(exact, false);
  assert.equal(lines.length, 6002);
  assert.deepEqual([lines[0].type, lines[1].type, lines[3000].type, lines[3001].type, lines.at(-1).type], ['context', 'remove', 'remove', 'add', 'context']);
  assert.deepEqual(lines.at(-1), { type: 'context', text: 'end', oldLine: 3002, newLine: 3002 });
  // Under the limit the same shape is diffed exactly.
  assert.equal(lineDiff('a\nb', 'c\nd', { cellLimit: 4 }).exact, true);
  assert.equal(lineDiff('a\nb', 'c\nd', { cellLimit: 3 }).exact, false);
});

test('lines and clipping', () => {
  assert.deepEqual(splitLines('a\r\nb\n'), ['a', 'b']);
  assert.deepEqual(splitLines('\n'), ['']);
  assert.deepEqual(splitLines(''), []);
  const many = Array.from({ length: 1000 }, (_, i) => i);
  const clipped = clipLines(many);
  assert.equal(clipped.shown.length, 400);
  assert.equal(clipped.hidden, 600);
  assert.deepEqual(clipLines([1, 2], 5), { shown: [1, 2], hidden: 0 });
});

test('links: http and https only', () => {
  assert.equal(safeLink('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(safeLink(' http://example.com '), 'http://example.com/');
  assert.equal(safeLink('javascript:alert(1)'), undefined);
  assert.equal(safeLink('data:text/html,x'), undefined);
  assert.equal(safeLink('/relative'), undefined);
  assert.equal(safeLink(42), undefined);
});
