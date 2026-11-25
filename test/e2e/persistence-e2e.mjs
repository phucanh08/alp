// Opt-in: real model calls. Kills alpd with SIGKILL mid-turn, restarts it, and checks what a
// user is left with (ALPD §31, §66): the interrupted turn is settled as daemon_restarted, alpd
// reopens the root by itself and sends it one recovery prompt (recovery.autoResume, on by
// default), and the session still has its native thread with the earlier context.
//
// ALP_TEST_FAKE=1 runs the same steps on the repo's fake Codex, with no model call: its [hold]
// marker stands for a long turn, and [codewords] for a model that recalls what its thread holds.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, readLock } from '../../packages/client/dist/index.js';
import { laneHome } from './home-guard.mjs';

const fake = process.env.ALP_TEST_FAKE === '1';
const model = fake ? 'codex:gpt-5.6-sol' : process.env.ALP_TEST_MODEL ?? 'codex:gpt-5.6-sol';
// Always a new temporary home (removed at the end), checked by the fail-closed guard (t-cad9).
const { home } = await laneHome({ prefix: 'alp-persist-', acceptGiven: false });
const support = name => fileURLToPath(new URL(`../../packages/daemon/tests/support/${name}`, import.meta.url));
const env = {
  ...process.env, ALP_HOME: home, ALP_RUN_LOG_DIR: path.join(home, 'runs'),
  // The fake keeps its threads in a file, as Codex's own store does, so the next alpd's provider sees them.
  ...(fake ? { ALP_CODEX_BIN: support('fake-codex.js'), ALP_CLAUDE_BIN: support('fake-claude.js'), FAKE_CODEX_STATE: path.join(home, 'fake-codex-threads.jsonl') } : {}),
};
// ALP_TEST_CLI runs another alp, such as a built bundle's bin/alp, which starts its native alpd (t-81b0.9).
const alp = process.env.ALP_TEST_CLI ? [process.env.ALP_TEST_CLI] : [process.execPath, 'packages/cli/dist/cli.js'];
const cli = (...args) => spawnSync(alp[0], [...alp.slice(1), ...args], { env, encoding: 'utf8' });

/** Runs the CLI with --json; resolves its envelopes, or calls `onEnvelope` as they stream. */
function stream(args, onEnvelope = () => {}) {
  const child = spawn(alp[0], [...alp.slice(1), ...args, '--json'], { env });
  const envelopes = [];
  let buffer = '';
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      const envelope = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      envelopes.push(envelope);
      onEnvelope(envelope, child);
    }
  });
  const done = new Promise(resolve => child.on('close', code => resolve({ code, envelopes })));
  return { child, done };
}
/**
 * The answer to the user's prompt: the last assistant message of the root turn the user started.
 * A stream follows the root until it is idle, so it can also hold turns ALP started (a recovery
 * prompt, a supervisor's check-in); what the agent says in those is not the answer (t-beb5).
 */
function userAnswer(envelopes, sessionId) {
  let inUserTurn = false;
  let answer = '';
  for (const { sessionId: id, event } of envelopes) {
    if (id !== sessionId) continue;
    if (event.type === 'turn.started') inUserTurn = event.origin === 'user';
    else if (inUserTurn && event.type === 'item' && event.item.kind === 'assistant_message') answer = event.item.text;
  }
  return answer;
}
/** Waits for a fact, not for time: resolves what `read` returns once it is truthy. */
async function until(read, what, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

const root = path.resolve('.alp-test', `persist-${Date.now()}`);
// The alp under test scaffolds the project on this lane's home, never from the caller's own library.
const scaffold = cli('init', root);
assert.equal(scaffold.status, 0, scaffold.stderr);
// No team: main alone, so no supervisor turn mixes into the streams below.
await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify({ defaultAgent: 'main' }));
const word = `ORCHID${randomUUID().slice(0, 8).toUpperCase()}`;
const prompts = {
  remember: `Remember the codeword ${word}. Reply only with OK.`,
  long: fake ? 'Stay in this turn. [hold]' : 'Run the shell command `sleep 30`, then reply only with DONE.',
  recall: fake ? 'Which codewords do you hold? [codewords]' : 'What was the codeword I asked you to remember? Reply with the word only.',
};

let client;
try {
  assert.equal(cli('daemon', 'start').status, 0);
  const first = await stream(['run', '--project', root, '--model', model, '--thinking', 'low', prompts.remember]).done;
  assert.equal(first.code, 0);
  const sessionId = first.envelopes.find(e => e.event.type === 'session.opened').sessionId;

  // Kill alpd while a turn runs.
  const { pid } = await readLock(home);
  // Which alpd ran (alp's native alpd, t-81b0.9, or alpd.js), for the evidence.
  const daemonEntry = JSON.parse(await readFile(path.join(home, 'alpd.json'), 'utf8')).entry;
  let killed = false;
  const second = stream(['send', sessionId, prompts.long], (envelope, child) => {
    if (!killed && envelope.sessionId === sessionId && envelope.event.type === 'turn.started') {
      killed = true;
      setTimeout(() => { process.kill(pid, 'SIGKILL'); child.kill(); }, fake ? 300 : 3000);
    }
  });
  await second.done;
  assert.ok(killed, 'the second turn started before the kill');

  assert.equal(cli('daemon', 'start').status, 0);
  // The root's timeline, replayed and then live. `session.get` right after the start is a race:
  // the root reads error/daemon_restarted only until recovery reopens it, some milliseconds later.
  client = await connect((await readLock(home)).socket);
  const events = [];
  client.onEvent(envelope => { if (envelope.sessionId === sessionId) events.push(envelope.event); });
  await client.request('session.attach', { sessionId });
  const wait = fake ? 20_000 : 240_000;
  const interrupted = await until(() => events.findIndex(event => event.type === 'turn.ended' && event.error?.code === 'daemon_restarted') + 1, 'the interrupted turn settled as daemon_restarted', wait) - 1;
  assert.equal(events[interrupted].state, 'failed');
  // alpd continues the root by itself: one recovery prompt, a turn ALP started, not the user's prompt again.
  const recovery = await until(() => events.findIndex((event, index) => index > interrupted && event.type === 'turn.started') + 1, 'the recovery turn', wait) - 1;
  assert.equal(events[recovery].origin, 'wake');
  const recovered = await until(() => events.find((event, index) => index > recovery && event.type === 'turn.ended'), 'the recovery turn to end', wait);
  assert.equal(recovered.state, 'completed');
  await until(async () => !(await client.request('session.get', { sessionId })).session.busy, 'the root to be idle', wait);
  const { session } = await client.request('session.get', { sessionId });
  assert.equal(session.status, 'idle');
  assert.equal(session.lastError, undefined, 'the reopened root carries no error');
  // `alp ps` prints a session's error code only while it is not live; this root is live again.
  const ps = cli('ps', '--all').stdout;
  const listed = ps.split('\n').find(line => line.startsWith(sessionId));
  assert.ok(listed, 'alp ps --all lists the root');
  assert.match(listed, /  idle  /);
  assert.doesNotMatch(listed, /daemon_restarted/);
  client.close();
  client = undefined;

  const third = await stream(['send', sessionId, prompts.recall]).done;
  assert.equal(third.code, 0);
  const answer = userAnswer(third.envelopes, sessionId);
  const turns = events.filter(event => event.type.startsWith('turn.')).map(event => event.type === 'turn.started' ? `started(${event.origin})` : `ended(${event.state}${event.error?.code ? `:${event.error.code}` : ''})`);
  const evidence = { home, project: root, model, fake, daemonEntry, sessionId, word, killedPid: pid, turns, statusAfterRecovery: session.status, ps, answer };
  await writeFile('.alp-test/persistence-e2e.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence));
  assert.ok(answer.includes(word), 'the resumed session remembers the codeword');
  console.log(JSON.stringify({ passed: true, evidence: '.alp-test/persistence-e2e.json' }));
} finally {
  client?.close();
  // Stop first, then remove: the project scaffolded under .alp-test goes too, only the evidence file stays.
  cli('daemon', 'stop');
  await rm(root, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
}
