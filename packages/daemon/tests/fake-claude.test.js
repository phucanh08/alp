// The fake Claude Code executable (support/fake-claude.js) behind a real alpd, as the fake acceptance
// run and the hermetic tests use it: ALP_CLAUDE_BIN points at it, ClaudeTransport drives it through
// the Claude Agent SDK, and a prompt is answered, a held turn is interrupted, and after a restart
// the session resumes its Claude session id. No model is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '@anhlp/alp-core/init';
import { connect, readLock } from '@anhlp/alp-client';

const ALPD = fileURLToPath(new URL('../dist/alpd.js', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('./support/fake-claude.js', import.meta.url));
const MODEL = 'claude:sonnet';
// ClaudeTransport refuses .cmd launchers and alpd's process groups are POSIX; Windows runs the fake through `alp doctor` only.
const skip = process.platform === 'win32' && 'POSIX processes only';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, what) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await sleep(25); }
  assert.fail(`${what} did not happen`);
}
const text = body => [{ type: 'text', text: body }];

test('the fake answers --version and auth status as alp doctor reads them', { skip: process.platform === 'win32' && 'runs the script by its shebang' }, () => {
  const version = spawnSync(FAKE_CLAUDE, ['--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0);
  assert.match(version.stdout, /^\d+\.\d+\.\d+ \(Claude Code\)\n$/);
  const auth = spawnSync(FAKE_CLAUDE, ['auth', 'status'], { encoding: 'utf8' });
  assert.equal(auth.status, 0);
  assert.equal(JSON.parse(auth.stdout).loggedIn, true);
});

test('alpd on the fake Claude: a prompt is answered, a held turn is interrupted, and a restart resumes the same session', { skip }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alpd-fake-claude-'));
  const home = path.join(directory, 'home');
  await mkdir(home, { mode: 0o700 });
  const project = path.join(directory, 'project');
  await initProject(project);
  // Main alone: no supervisor reviews the turns.
  await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ workflow: { supervisor: false } }));
  const journalFile = path.join(directory, 'claude.jsonl');
  const logFile = path.join(directory, 'alpd.log');
  const journal = async () => (await readFile(journalFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const started = [];
  t.after(async () => {
    for (const child of started) if (child.exitCode === null && child.signalCode === null) try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function start() {
    const log = openSync(logFile, 'a');
    const child = spawn(process.execPath, [ALPD], {
      detached: true, stdio: ['ignore', log, log],
      env: { ...process.env, ALP_HOME: home, ALP_CLAUDE_BIN: FAKE_CLAUDE, FAKE_CLAUDE_JOURNAL: journalFile },
    });
    closeSync(log);
    const exited = once(child, 'exit');
    let gone = false;
    void exited.then(() => { gone = true; });
    started.push(child);
    await until(async () => {
      if (gone) assert.fail(`alpd exited while starting:\n${await readFile(logFile, 'utf8')}`);
      const lock = await readLock(home);
      return lock?.ready && lock.pid === child.pid;
    }, 'alpd to be ready');
    const client = await connect((await readLock(home)).socket, { name: 'fake-claude-test', version: '0' });
    const events = [];
    client.onEvent(envelope => events.push(envelope));
    return {
      events,
      request: (method, params) => client.request(method, params),
      async stop() { await client.request('daemon.shutdown').catch(() => {}); client.close(); await exited; },
    };
  }
  const ended = (daemon, after) => daemon.events.filter(e => e.event.type === 'turn.ended').slice(after);
  const answers = daemon => daemon.events.filter(e => e.event.type === 'item' && /^ok \d+: /.test(e.event.item?.text ?? '')).map(e => e.event.item.text);

  const first = await start();
  const { session } = await first.request('session.create', { spec: { cwd: project, persist: true, model: MODEL } });

  // A prompt: answered, and its turn completes.
  assert.equal((await first.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('hello fake') })).outcome, 'accepted');
  await until(() => ended(first, 0).length === 1, 'the first turn to end');
  assert.equal(ended(first, 0)[0].event.state, 'completed');
  assert.ok(answers(first).some(answer => answer.includes('hello fake')), `an answer echoing the prompt: ${JSON.stringify(answers(first))}`);
  const [spawned] = (await journal()).filter(entry => entry.method === 'spawn' && !entry.resume);
  assert.match(spawned.sessionId, /^[0-9a-f-]{36}$/);
  assert.ok(spawned.args.includes(`--session-id=${spawned.sessionId}`));

  // t-e906: /clear and its aliases are refused by session.prompt before anything is sent or recorded.
  for (const [id, body] of [['c1', '/clear'], ['c2', '/new please'], ['c3', '  /reset']]) {
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(first.request('session.prompt', { sessionId: session.id, clientMessageId: id, content: text(body) }), error => {
        assert.equal(error.code, -32602);
        assert.equal(error.data?.reason, 'native_command_unsupported');
        assert.match(error.message, /does not pass \/clear/);
        return true;
      }, `${body} (attempt ${attempt + 1})`);
    }
  }
  assert.ok(!(await journal()).some(entry => entry.method === 'user' && /^\s*\/(?:clear|new|reset)\b/.test(entry.text ?? '')), 'nothing reached Claude');
  assert.equal(ended(first, 0).length, 1, 'no turn started');

  // A held turn: it runs until alp interrupts it, then ends canceled.
  await first.request('session.prompt', { sessionId: session.id, clientMessageId: 'm2', content: text('count slowly [hold]') });
  await until(() => first.events.some(e => e.event.type === 'turn.started' && e.cursor > ended(first, 0)[0].cursor), 'the held turn to start');
  await sleep(100);
  assert.equal(ended(first, 0).length, 1, 'a held turn does not end by itself');
  await first.request('session.interrupt', { sessionId: session.id });
  await until(() => ended(first, 0).length === 2, 'the held turn to end');
  assert.equal(ended(first, 0)[1].event.state, 'canceled');
  await until(async () => (await journal()).some(entry => entry.method === 'turn/end' && entry.subtype === 'error_during_execution'), 'the fake to end its turn on the interrupt');
  assert.ok((await journal()).some(entry => entry.method === 'interrupt'));

  // A restart: the session resumes the same Claude session and answers again.
  await first.stop();
  const second = await start();
  t.after(() => second.stop());
  await second.request('session.create', { sessionId: session.id, spec: { cwd: project, persist: true, model: MODEL } });
  assert.equal((await second.request('session.prompt', { sessionId: session.id, clientMessageId: 'm3', content: text('again after restart') })).outcome, 'accepted');
  await until(() => ended(second, 0).some(e => e.event.state === 'completed'), 'the resumed turn to complete');
  assert.ok(answers(second).some(answer => answer.includes('again after restart')));
  const resumed = (await journal()).filter(entry => entry.method === 'spawn' && entry.resume);
  assert.ok(resumed.length >= 1, 'alpd started the fake with --resume');
  assert.ok(resumed.every(entry => entry.resume === spawned.sessionId && entry.sessionId === spawned.sessionId));
  assert.ok((await journal()).some(entry => entry.method === 'user' && entry.sessionId === spawned.sessionId && entry.text.includes('again after restart')));
});
