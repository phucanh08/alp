// Paseo parity batch 3 (t-de48): find in a chat pane, the composer's "@" files, the command
// center's agent rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FIND_LIMIT, findMatches, findStatus, isFindShortcut, stepMatch } from '../src/lib/pane-find.js';
import { insertMention, mentionAt, mentionText } from '../src/lib/mentions.js';
import { commandResults } from '../src/lib/command-center.js';

const key = (init) => ({ key: 'f', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...init });

test('Cmd+F on a Mac and Ctrl+F elsewhere is find; another modifier is not', () => {
  assert.equal(isFindShortcut(key({ metaKey: true }), true), true);
  assert.equal(isFindShortcut(key({ key: 'F', metaKey: true }), true), true);
  assert.equal(isFindShortcut(key({ ctrlKey: true }), true), false);
  assert.equal(isFindShortcut(key({ ctrlKey: true }), false), true);
  assert.equal(isFindShortcut(key({ metaKey: true }), false), false);
  assert.equal(isFindShortcut(key({ metaKey: true, shiftKey: true }), true), false);
  assert.equal(isFindShortcut(key({ metaKey: true, altKey: true }), true), false);
  assert.equal(isFindShortcut(key({ key: 'g', metaKey: true }), true), false);
});

test('find ignores case and returns each match\'s start and end in reading order', () => {
  const { matches, limited } = findMatches([{ text: 'Alpha beta ALPHA' }, { text: 'gamma alpha', breakBefore: true }], 'alpha');
  assert.equal(limited, false);
  assert.deepEqual(matches, [
    { start: { segment: 0, offset: 0 }, end: { segment: 0, offset: 5 } },
    { start: { segment: 0, offset: 11 }, end: { segment: 0, offset: 16 } },
    { start: { segment: 1, offset: 6 }, end: { segment: 1, offset: 11 } },
  ]);
});

test('a match runs across the segments of one block (a bold word) but never across blocks', () => {
  const inline = findMatches([{ text: 'the qu' }, { text: 'ick' }, { text: ' fox' }], 'quick fox');
  assert.deepEqual(inline.matches, [{ start: { segment: 0, offset: 4 }, end: { segment: 2, offset: 4 } }]);
  // An end on a boundary stays in the segment before it.
  assert.deepEqual(findMatches([{ text: 'ab' }, { text: 'cd' }], 'ab').matches, [{ start: { segment: 0, offset: 0 }, end: { segment: 0, offset: 2 } }]);
  assert.deepEqual(findMatches([{ text: 'ab' }, { text: 'cd' }], 'cd').matches, [{ start: { segment: 1, offset: 0 }, end: { segment: 1, offset: 2 } }]);
  assert.deepEqual(findMatches([{ text: 'one' }, { text: 'two', breakBefore: true }], 'etw').matches, []);
});

test('an empty or blank query finds nothing; matches past the limit are cut', () => {
  assert.deepEqual(findMatches([{ text: 'a b' }], '').matches, []);
  assert.deepEqual(findMatches([{ text: 'a b' }], '  ').matches, []);
  const many = findMatches([{ text: 'x'.repeat(FIND_LIMIT + 5) }], 'x');
  assert.equal(many.matches.length, FIND_LIMIT);
  assert.equal(many.limited, true);
  // Matches do not overlap.
  assert.equal(findMatches([{ text: 'aaaa' }], 'aa').matches.length, 2);
});

test('next and previous wrap; the status says where the reader is', () => {
  assert.equal(stepMatch(0, 3, 1), 1);
  assert.equal(stepMatch(2, 3, 1), 0);
  assert.equal(stepMatch(0, 3, -1), 2);
  assert.equal(stepMatch(0, 0, 1), 0);
  assert.equal(findStatus('', 0, 0), '');
  assert.equal(findStatus('x', 0, 0), 'No matches');
  assert.equal(findStatus('x', 1, 4), '2 of 4');
  assert.equal(findStatus('x', 0, FIND_LIMIT, true), `1 of ${FIND_LIMIT}+`);
});

test('an "@" word at the caret is a file mention: at the start or after whitespace, up to the caret', () => {
  assert.deepEqual(mentionAt('@', 1), { start: 0, end: 1, query: '' });
  assert.deepEqual(mentionAt('see @src/ca', 11), { start: 4, end: 11, query: 'src/ca' });
  assert.deepEqual(mentionAt('see @src/ca and more', 11), { start: 4, end: 11, query: 'src/ca' });
  assert.deepEqual(mentionAt('line\n@rea', 9), { start: 5, end: 9, query: 'rea' });
  for (const [text, caret] of [['mail@example.com', 16], ['@a b', 4], ['', 0], ['see @x', 3], ['@a@b', 4]]) assert.equal(mentionAt(text, caret), null, JSON.stringify([text, caret]));
});

test('choosing a file puts @<path> and a space in place of the whole word', () => {
  assert.deepEqual(insertMention('see @ca', { start: 4, end: 7 }, 'src/checkout/cart-total.ts'), { text: 'see @src/checkout/cart-total.ts ', caret: 32 });
  // The caret in the middle of the word: the rest of the word goes too, the text after stays.
  assert.deepEqual(insertMention('see @cart now', { start: 4, end: 6 }, 'cart.ts'), { text: 'see @cart.ts now', caret: 13 });
  assert.equal(mentionText('docs/my notes.md'), '@"docs/my notes.md"');
  assert.deepEqual(insertMention('@', { start: 0, end: 1 }, 'a b.txt'), { text: '@"a b.txt" ', caret: 11 });
});

test('the command center\'s agent rows show only when searched for, in their own Agent section', () => {
  const actions = [
    { id: 'new-session', label: 'New session', group: 'workspace', always: true },
    { id: 'agent-model:codex:gpt-a', label: 'Model: GPT A', group: 'agent', checked: true, keywords: ['model'] },
    { id: 'agent-model:codex:gpt-b', label: 'Model: GPT B', group: 'agent', keywords: ['model'] },
    { id: 'agent-thinking:high', label: 'Thinking: High', group: 'agent', keywords: ['thinking', 'effort'] },
    { id: 'agent-mode:read-only', label: 'Mode: Read only', group: 'agent', keywords: ['mode', 'permissions'] },
  ];
  assert.ok(!commandResults({ actions, sessions: [], query: '' }).some(section => section.id === 'agent'));
  const model = commandResults({ actions, sessions: [], query: 'model' });
  assert.deepEqual(model[0].title, 'Agent');
  // The model rows first ("Mode: …" holds the letters of "model" in order, so it may follow).
  assert.deepEqual(model[0].rows.slice(0, 2).map(row => row.item.id), ['agent-model:codex:gpt-a', 'agent-model:codex:gpt-b']);
  assert.deepEqual(commandResults({ actions, sessions: [], query: 'effort' })[0].rows.map(row => row.item.id), ['agent-thinking:high']);
  assert.deepEqual(commandResults({ actions, sessions: [], query: 'permissions' })[0].rows.map(row => row.item.id), ['agent-mode:read-only']);
});
