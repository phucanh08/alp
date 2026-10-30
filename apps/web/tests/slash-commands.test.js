// The composer's "/" suggestions (t-f628).
import test from 'node:test';
import assert from 'node:assert/strict';
import { insertCommand, matchCommands, slashQuery } from '../src/lib/slash-commands.js';

const commands = [
  { name: 'compact', description: 'Clear history', argumentHint: '<what>', kind: 'command' },
  { name: 'review', description: 'Review a PR', kind: 'command' },
  { name: 'alp:xia', description: 'Research', kind: 'skill' },
  { name: 'alp:bug-loop', description: 'Debug', kind: 'skill' },
  { name: 'alp:compact', description: 'Checkpoint', kind: 'skill' },
];
const names = list => list.map(command => command.name);

test('only a "/" at the start of the box, before any space, is a command being typed', () => {
  assert.equal(slashQuery('/'), '');
  assert.equal(slashQuery('/al'), 'al');
  assert.equal(slashQuery('/alp:xia'), 'alp:xia');
  for (const text of ['', 'hi /x', ' /x', '/xia ', '/xia args', '/x\ny']) assert.equal(slashQuery(text), null, JSON.stringify(text));
});

test('"/" alone lists every command and skill in the runtime\'s order', () => {
  assert.deepEqual(names(matchCommands(commands, '/')), names(commands));
  assert.equal(matchCommands(commands, 'text'), null);
});

test('the typed word filters, case-insensitively: name prefix first, then after a colon, then anywhere', () => {
  assert.deepEqual(names(matchCommands(commands, '/comp')), ['compact', 'alp:compact']);
  assert.deepEqual(names(matchCommands(commands, '/XI')), ['alp:xia']);
  assert.deepEqual(names(matchCommands(commands, '/alp')), ['alp:xia', 'alp:bug-loop', 'alp:compact']);
  assert.deepEqual(names(matchCommands(commands, '/loop')), ['alp:bug-loop']);
  assert.deepEqual(matchCommands(commands, '/zzz'), []);
});

test('choosing a command puts its name and a space in the box', () => {
  assert.equal(insertCommand(commands[2]), '/alp:xia ');
});
