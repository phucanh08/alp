// Paseo 0.14's Chat display (lib/chat-display.js): Full keeps every row, Collapse tool calls folds
// runs of two or more tool calls into one summary row, Collapse turns also folds each finished
// turn's work before its last reply into one line under the user's message.
import test from 'node:test';
import assert from 'node:assert/strict';
import { displayRows, isGroupable, summarizeWork, summaryLabel } from '../src/lib/chat-display.js';

let seq = 0;
const entry = item => ({ key: `e${++seq}`, ts: '2026-10-30T00:00:00Z', item });
const user = text => entry({ kind: 'user_message', text });
const reply = text => entry({ kind: 'assistant_message', text });
const tool = (type, extra = {}, status = 'completed') => entry({ kind: 'tool_call', name: type, status, detail: { type, ...extra } });
const shape = rows => rows.map(row => row.type === 'entry' ? `${row.nested ? '>' : ''}${row.entry.item.kind}` : row.type === 'group' ? `group(${row.entries.length})` : `turn(${row.expanded ? 'open' : 'closed'})`);

test('the summary counts files once and commands each time, in Paseo\'s words', () => {
  const work = [tool('edit', { filePath: 'a.ts' }), tool('write', { filePath: 'a.ts' }), tool('edit', { filePath: 'b.ts' }), tool('shell'), tool('shell'), tool('read', { filePath: 'c.ts' }), tool('search'), tool('fetch'), reply('x')];
  const summary = summarizeWork(work);
  assert.deepEqual(summary, { editedFileCount: 2, commandCount: 2, readFileCount: 1, searchCount: 1, otherToolCount: 1 });
  assert.equal(summaryLabel(summary), 'Edited 2 files, ran 2 commands, read 1 file, searched 1 time, and used 1 other tool');
  assert.equal(summaryLabel(summarizeWork([tool('shell')])), 'Ran 1 command');
  assert.equal(summaryLabel(summarizeWork([tool('shell'), tool('read', { filePath: 'x' })])), 'Ran 1 command and read 1 file');
  assert.equal(summaryLabel(summarizeWork([])), '');
  // A tool named like a search counts as one (Grep, Glob).
  assert.equal(summarizeWork([entry({ kind: 'tool_call', name: 'Grep', detail: { type: 'unknown' } })]).searchCount, 1);
});

test('plans never group; other tool calls do', () => {
  assert.equal(isGroupable(tool('shell')), true);
  assert.equal(isGroupable(tool('plan')), false);
  assert.equal(isGroupable(entry({ kind: 'todo', items: [] })), false);
  assert.equal(isGroupable(reply('x')), false);
});

test('Full shows every row', () => {
  const entries = [user('go'), tool('shell'), tool('shell'), reply('done')];
  assert.deepEqual(shape(displayRows(entries, { display: 'full', running: false })), ['user_message', 'tool_call', 'tool_call', 'assistant_message']);
});

test('Collapse tool calls: runs of two or more become one group; one call, a plan or a reply breaks the run', () => {
  const entries = [user('go'), tool('shell'), tool('read', { filePath: 'a' }), reply('mid'), tool('shell'), tool('plan'), tool('edit', { filePath: 'b' }), tool('shell', {}, 'running')];
  const rows = displayRows(entries, { display: 'collapseToolCalls', running: true });
  assert.deepEqual(shape(rows), ['user_message', 'group(2)', 'assistant_message', 'tool_call', 'tool_call', 'group(2)']);
  assert.equal(rows[1].loading, false);
  assert.equal(rows.at(-1).loading, true, 'a group with a running call shows as loading');
  assert.equal(rows[1].key, `group:${entries[1].key}`, 'a group keeps the key of its first call');
});

test('Collapse turns: a finished turn folds its work before the last reply into one line; the reply stays', () => {
  const entries = [user('first'), tool('shell'), reply('thinking aloud'), tool('edit', { filePath: 'a' }), reply('done'), user('second'), tool('shell'), reply('ok')];
  const rows = displayRows(entries, { display: 'collapseTurns', running: false });
  assert.deepEqual(shape(rows), ['user_message', 'turn(closed)', 'assistant_message', 'user_message', 'turn(closed)', 'assistant_message']);
  assert.equal(summaryLabel(rows[1].summary), 'Edited 1 file and ran 1 command');
  assert.equal(rows[2].entry.item.text, 'done');
  assert.equal(rows[1].entries.length, 3, 'the folded rows are kept for the reader to open');
});

test('Collapse turns: opening a turn shows its rows nested, ungrouped', () => {
  const entries = [user('first'), tool('shell'), tool('shell'), reply('done')];
  const rows = displayRows(entries, { display: 'collapseTurns', running: false, expandedTurns: new Set([entries[0].key]) });
  assert.deepEqual(shape(rows), ['user_message', 'turn(open)', '>tool_call', '>tool_call', 'assistant_message']);
});

test('Collapse turns: the running turn, a turn with no reply and a reply with nothing before it do not fold', () => {
  const working = [user('go'), tool('shell'), reply('so far'), tool('shell')];
  assert.deepEqual(shape(displayRows(working, { display: 'collapseTurns', running: true })), ['user_message', 'tool_call', 'assistant_message', 'tool_call']);
  const unanswered = [user('go'), tool('shell'), tool('shell')];
  assert.deepEqual(shape(displayRows(unanswered, { display: 'collapseTurns', running: false })), ['user_message', 'group(2)']);
  const direct = [user('hi'), reply('hello')];
  assert.deepEqual(shape(displayRows(direct, { display: 'collapseTurns', running: false })), ['user_message', 'assistant_message']);
  // An earlier finished turn folds even while a later one runs.
  const later = [user('one'), tool('shell'), reply('done'), user('two'), tool('shell')];
  assert.deepEqual(shape(displayRows(later, { display: 'collapseTurns', running: true })), ['user_message', 'turn(closed)', 'assistant_message', 'user_message', 'tool_call']);
});

test('Collapse turns: compaction stays visible in a folded turn; a boundary marker ends a turn', () => {
  const compaction = entry({ kind: 'compaction', status: 'completed' });
  const entries = [user('go'), tool('shell'), compaction, reply('done')];
  assert.deepEqual(shape(displayRows(entries, { display: 'collapseTurns', running: false })), ['user_message', 'turn(closed)', 'compaction', 'assistant_message']);
  const marker = entry({ kind: 'notice', text: 'fork' });
  const marked = [user('go'), tool('shell'), reply('done'), marker, tool('shell'), reply('after')];
  const rows = displayRows(marked, { display: 'collapseTurns', running: false, isBoundary: candidate => candidate === marker });
  assert.deepEqual(shape(rows), ['user_message', 'turn(closed)', 'assistant_message', 'notice', 'tool_call', 'assistant_message']);
});
