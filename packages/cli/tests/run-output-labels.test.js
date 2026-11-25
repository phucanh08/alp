import test from 'node:test';
import assert from 'node:assert/strict';
import { answerLabel, printer } from '../src/commands/sessions.js';

// t-beb5: `alp run` follows the root until it is idle, so its human output can show a turn ALP
// started after the answer (a supervisor's check-in, mail). A person must tell the answer to their
// prompt from that turn's text; `--json` output is unchanged.

const e = (sessionId, event) => ({ sessionId, event });
const opened = (id, agent, parentId) => e(id, { type: 'session.opened', session: { agent, runtime: 'codex', model: 'gpt', mode: 'full-access', ...(parentId ? { parentId } : {}) } });
const say = (sessionId, id, text) => e(sessionId, { type: 'item', item: { kind: 'assistant_message', id, text } });
const turn = (sessionId, origin, turnId) => [e(sessionId, { type: 'turn.started', origin, turnId }), e(sessionId, { type: 'turn.ended', turnId, state: 'completed' })];

function capture(envelopes, json = false) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    const print = printer(json);
    for (const envelope of envelopes) print(envelope);
  } finally { console.log = original; }
  return lines;
}

const stream = () => {
  const [userStart, userEnd] = turn('root', 'user', 't1');
  const [wakeStart, wakeEnd] = turn('root', 'wake', 't2');
  const [childStart, childEnd] = turn('child', 'assignment', 'c1');
  return [
    opened('root', 'main'), userStart, say('root', 'm1', 'The folder has README.md.'), userEnd,
    opened('child', 'lead', 'root'), childStart, say('child', 'm2', 'lead result'), childEnd,
    wakeStart, say('root', 'm3', 'Per the supervisor, I recorded a lesson.'), wakeEnd,
  ];
};

test('the answer in the user turn keeps the plain label; a root turn ALP started names its origin', () => {
  const lines = capture(stream());
  assert.ok(lines.includes('  main: The folder has README.md.'), lines.join('\n'));
  assert.ok(lines.includes('  main [wake turn]: Per the supervisor, I recorded a lesson.'), lines.join('\n'));
  // A child's turns are assignments: its label stays plain.
  assert.ok(lines.includes('    lead: lead result'), lines.join('\n'));
  assert.ok(!lines.some(line => line.includes('[user turn]') || line.includes('[assignment turn]')), lines.join('\n'));
});

test('--json prints each envelope unchanged', () => {
  const envelopes = stream();
  assert.deepEqual(capture(envelopes, true), envelopes.map(envelope => JSON.stringify(envelope)));
});

test('answerLabel marks only a root turn whose origin is not user', () => {
  assert.equal(answerLabel('main', { root: true, origin: 'user' }), 'main');
  assert.equal(answerLabel('main', { root: true, origin: undefined }), 'main');
  assert.equal(answerLabel('main', { root: true, origin: 'wake' }), 'main [wake turn]');
  assert.equal(answerLabel('main', { root: true, origin: 'runtime' }), 'main [runtime turn]');
  assert.equal(answerLabel('lead', { root: false, origin: 'assignment' }), 'lead');
});
