// t-beb5: `alp run` follows the root until it is idle, so its --json stream also holds turns ALP
// started after the answer, such as the one a supervisor's note wakes. The acceptance kit must read
// C4/C8's answer from the user's turn, not take the root's last message.
//
// Fake mode, no model call: a real alpd and the repo's fake Codex, behind a small proxy this test
// writes. The proxy marks the supervisor's review turn with the fake's [ask] marker and turns the
// alp_ask call that follows into the supervisor's alp_send note to main, which is what a real
// supervisor does when it checks in. Main's fake then answers that woken turn with text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { follow, userTurnAnswers } from '../../scripts/beta-acceptance-lib.ts';
import { teardown } from '../support/teardown.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ALP = path.join(ROOT, 'packages/cli/dist/cli.js');
const FAKE_CODEX = path.join(ROOT, 'packages/daemon/tests/support/fake-codex.js');
const FAKE_CLAUDE = path.join(ROOT, 'packages/daemon/tests/support/fake-claude.js');
const MODEL = 'codex:gpt-5.6-sol';
const NOTE = 'Supervisor check-in: did you verify the listing before you answered?';

const PROXY = `#!/usr/bin/env node
// Test-only proxy in front of the fake Codex (t-beb5); see beta-acceptance-user-turn.test.js.
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const child = spawn(process.execPath, [${JSON.stringify(FAKE_CODEX)}, ...process.argv.slice(2)], { stdio: ['pipe', 'pipe', 'inherit'] });
const reviewing = new Set();
createInterface({ input: process.stdin }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { child.stdin.write(line + '\\n'); return; }
  const input = message.params?.input;
  if (message.method === 'turn/start' && Array.isArray(input) && input.some(part => String(part.text ?? '').includes("Digest of main's turn"))) {
    reviewing.add(message.params.threadId);
    message.params.input = [...input, { type: 'text', text: '[ask]' }];
  }
  child.stdin.write(JSON.stringify(message) + '\\n');
}).on('close', () => child.stdin.end());
createInterface({ input: child.stdout }).on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { process.stdout.write(line + '\\n'); return; }
  if (message.method === 'item/tool/call' && message.params?.tool === 'alp_ask' && reviewing.has(message.params.threadId)) {
    reviewing.delete(message.params.threadId);
    message.params.tool = 'alp_send';
    message.params.arguments = { to: 'parent', kind: 'note', body: ${JSON.stringify(NOTE)} };
  }
  process.stdout.write(JSON.stringify(message) + '\\n');
});
child.on('exit', code => process.exit(code ?? 0));
process.on('SIGTERM', () => child.kill('SIGTERM'));
`;

test('C4 reads the answer of the user turn, not main\'s reply to the supervisor that follows it', async t => {
  const defer = teardown(t);
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'alp-beb5-')));
  defer(() => rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const project = path.join(base, 'project');
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(project);
  const proxy = path.join(base, 'codex-proxy.cjs');
  writeFileSync(proxy, PROXY, { mode: 0o755 });
  const env = {
    ...process.env, ALP_HOME: home, ALP_CODEX_BIN: proxy, ALP_CLAUDE_BIN: FAKE_CLAUDE, ALP_MODEL_CATALOG: 'static',
    FAKE_CODEX_STATE: path.join(base, 'fake-codex-threads.jsonl'), ALP_ACCEPT_TIMEOUT_MS: '60000',
  };
  delete env.ALP_AGENT_SESSION;
  const cli = (...args) => spawnSync(process.execPath, [ALP, ...args], { env, cwd: project, encoding: 'utf8' });

  const init = cli('init');
  assert.equal(init.status, 0, init.stderr);
  // Phở's supervisor on the fake Codex too, so the proxy sees its review turn.
  const settingsFile = path.join(project, '.alp', 'settings.json');
  const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
  settings.team.pho.supervisor = { ...settings.team.pho.supervisor, profiles: [`${MODEL}:low`] };
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  const started = cli('daemon', 'start');
  assert.equal(started.status, 0, started.stderr);
  defer(() => { cli('daemon', 'stop'); });

  const stream = follow({ log() {} }, 'C4', ['run', '--json', '--team', 'pho', '--model', MODEL, 'Read this folder and say which files it has. Change nothing.'], { env, cwd: project, alp: ALP });
  defer(() => stream.stop());
  assert.equal(await stream.exit, 0, stream.stderr());

  const root = stream.rootId;
  const origins = stream.envelopes.filter(e => e.sessionId === root && e.event?.type === 'turn.started').map(e => e.event.origin);
  // The sequence of the bug: the user's turn, then a turn ALP started on the supervisor's note.
  assert.equal(origins[0], 'user', `root turns: ${origins.join(', ')}`);
  assert.ok(origins.slice(1).some(origin => origin !== 'user'), `no woken root turn followed the answer: ${origins.join(', ')}`);
  const all = stream.allAnswers();
  const answers = stream.answers();
  assert.ok(answers.length >= 1, 'the user turn has an answer');
  assert.ok(all.length > answers.length, `main said nothing outside the user turn: ${JSON.stringify(all)}`);
  // The old reading (the root's last message) picks main's reply to the supervisor ...
  assert.notEqual(all.at(-1), answers.at(-1));
  // ... the kit now reads the user turn's answer.
  assert.deepEqual(answers, userTurnAnswers(stream.envelopes, root));
  const userTurn = stream.envelopes.find(e => e.sessionId === root && e.event?.type === 'turn.started' && e.event.origin === 'user').event.turnId;
  const userEnd = stream.envelopes.findIndex(e => e.sessionId === root && e.event?.type === 'turn.ended' && e.event.turnId === userTurn);
  const lastUserMessage = stream.envelopes.slice(0, userEnd).filter(e => e.sessionId === root && e.event?.type === 'item' && e.event.item?.kind === 'assistant_message').at(-1).event.item.text;
  assert.equal(answers.at(-1), lastUserMessage);
});

test('userTurnAnswers keeps only the root\'s messages in turns of origin user', () => {
  const e = (sessionId, event) => ({ sessionId, event });
  const say = text => ({ type: 'item', item: { kind: 'assistant_message', id: text, text } });
  const envelopes = [
    e('root', { type: 'turn.started', origin: 'user', turnId: 't1' }), e('root', say('answer')), e('child', say('child talk')),
    e('root', { type: 'turn.ended', turnId: 't1', state: 'completed' }), e('root', say('between turns')),
    e('root', { type: 'turn.started', origin: 'wake', turnId: 't2' }), e('root', say('reply to the supervisor')),
    e('root', { type: 'turn.ended', turnId: 't2', state: 'completed' }),
    e('root', { type: 'turn.started', origin: 'user', turnId: 't3' }), e('root', say('second answer')),
  ];
  assert.deepEqual(userTurnAnswers(envelopes, 'root'), ['answer', 'second answer']);
  assert.deepEqual(userTurnAnswers(envelopes, 'other'), []);
});
