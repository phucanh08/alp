// session.rewind and session.fork across crashes of a real alpd (docs/protocol/alp-json-rpc-v1.md §12.7,
// issue #121 branch C): alpd killed at each step of the lifecycle journal, with a fake Codex app-server
// that keeps threads, turns and forks in a file every provider process shares (support/fake-codex.js),
// then restarted on the same home. Never a native step twice; one result for every repeat; the next
// reply sees only the kept turns. No model is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { openSync, closeSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '@anhlp/alp-core/init';
import { connect, readLock } from '@anhlp/alp-client';

const ALPD = fileURLToPath(new URL('../dist/alpd.js', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('./support/fake-codex.js', import.meta.url));
const MODEL = 'codex:gpt-5.6-sol';
const skip = process.platform === 'win32' && 'POSIX processes only';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
async function until(check, what) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await sleep(25); }
  assert.fail(`${what} did not happen`);
}
const text = body => [{ type: 'text', text: body }];
const rpcError = (code, reason) => error => error?.code === code && error.data?.reason === reason;

async function harness(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alpd-conv-crash-'));
  const home = path.join(directory, 'home');
  await mkdir(home, { mode: 0o700 });
  await writeFile(path.join(home, 'settings.json'), '{}');
  const project = path.join(directory, 'project');
  await initProject(project);
  await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ workflow: { supervisor: false } }));
  // A file of the workspace: no fork or rewind may change it.
  const file = path.join(project, 'notes.txt');
  await writeFile(file, 'kept as it is\n');
  const journalFile = path.join(directory, 'provider.jsonl');
  const stateFile = path.join(directory, 'codex-state.jsonl');
  const logFile = path.join(directory, 'alpd.log');
  const started = [];
  const journal = async () => (await readFile(journalFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));

  async function start({ crashAt } = {}) {
    const log = openSync(logFile, 'a');
    const child = spawn(process.execPath, [ALPD], {
      detached: true, stdio: ['ignore', log, log],
      env: { ...process.env, ALP_HOME: home, ALP_CODEX_BIN: FAKE_CODEX, FAKE_CODEX_JOURNAL: journalFile, FAKE_CODEX_STATE: stateFile, ...(crashAt ? { ALP_TEST_CRASH_AT: crashAt } : {}) },
    });
    closeSync(log);
    const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal }));
    let gone = false;
    void exited.then(() => { gone = true; });
    started.push(child);
    await until(async () => {
      if (gone) assert.fail(`alpd exited while starting:\n${await readFile(logFile, 'utf8')}`);
      const lock = await readLock(home);
      return lock?.ready && lock.pid === child.pid;
    }, 'alpd to be ready');
    const client = await connect((await readLock(home)).socket, { name: 'conv-crash', version: '0' });
    return {
      client, request: (method, params) => client.request(method, params),
      async crashed() { const result = await exited; client.close(); assert.equal(result.signal, 'SIGKILL'); },
      async stop() { await client.request('daemon.shutdown').catch(() => {}); client.close(); await exited; },
    };
  }

  t.after(async () => {
    for (const child of started) if (child.exitCode === null && child.signalCode === null) try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    for (const { pid } of await journal()) if (alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch {}
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  /** A root with completed turns, one per text; answers its id and turn ids. */
  async function conversation(daemon, texts) {
    const { session } = await daemon.request('session.create', { spec: { cwd: project, persist: true, model: MODEL } });
    const turns = [];
    for (const [index, body] of texts.entries()) {
      await daemon.request('session.prompt', { sessionId: session.id, clientMessageId: `m${index}`, content: text(body) });
      await until(async () => { const now = (await daemon.request('session.get', { sessionId: session.id })).session; return !now.busy && !now.activeTurnId; }, `turn ${index}`);
    }
    const page = await daemon.request('session.history', { sessionId: session.id });
    for (const item of page.items) if (item.event?.type === 'turn.started') turns.push(item.event.turnId);
    return { id: session.id, turns, generation: page.generation };
  }

  /** The text of the last assistant message of a session after asking `[codewords]` with `messageId`. */
  async function codewords(daemon, sessionId, messageId) {
    await daemon.request('session.prompt', { sessionId, clientMessageId: messageId, content: text('[codewords]') });
    let answer;
    await until(async () => {
      const items = (await daemon.request('session.history', { sessionId })).items.filter(item => item.event?.type === 'item' && item.event.item.kind === 'assistant_message');
      answer = items.at(-1)?.event.item.text;
      return answer?.startsWith('codewords:') && !(await daemon.request('session.get', { sessionId })).session.busy;
    }, 'codewords answer');
    return answer;
  }

  const forks = async () => (await journal()).filter(entry => entry.method === 'thread/fork');
  return { home, project, file, stateFile, journal, forks, start, conversation, codewords };
}

for (const crashAt of ['rewind.after-prepared', 'rewind.after-applied', 'rewind.before-timeline', 'rewind.after-timeline', 'rewind.before-committed']) {
  test(`rewind killed at ${crashAt}: one result after the restart, never a second native fork`, { skip }, async t => {
    const h = await harness(t);
    const first = await h.start({ crashAt });
    const { id, turns, generation } = await h.conversation(first, ['codeword ALPHA', 'codeword BRAVO']);
    const threadBefore = (await first.request('session.get', { sessionId: id })).session.threadId;
    await assert.rejects(first.request('session.rewind', { sessionId: id, requestId: 'rw', ifGeneration: generation, beforeTurnId: turns[1] }));
    await first.crashed();
    const forked = (await h.forks()).length;
    assert.equal(forked, crashAt === 'rewind.after-prepared' ? 0 : 1);

    const second = await h.start();
    t.after(() => second.stop());
    const repeat = () => second.request('session.rewind', { sessionId: id, requestId: 'rw', ifGeneration: generation, beforeTurnId: turns[1] });
    if (crashAt === 'rewind.after-prepared') {
      // The native step may or may not have happened: unknown, now and always, and the binding did not move.
      await assert.rejects(repeat(), rpcError(1004, 'outcome_unknown'));
      await assert.rejects(repeat(), rpcError(1004, 'outcome_unknown'));
      assert.equal((await second.request('session.get', { sessionId: id })).session.threadId, threadBefore);
      assert.equal((await h.forks()).length, 0);
      return;
    }
    // Rolled forward at the start: the repeat answers the one result, the native fork happened once.
    const result = await repeat();
    assert.equal(result.duplicate, true);
    assert.equal(result.branch.beforeTurnId, turns[1]);
    assert.equal((await h.forks()).length, 1);
    const session = (await second.request('session.get', { sessionId: id })).session;
    assert.notEqual(session.threadId, threadBefore);
    assert.deepEqual(session.branches, [result.branch]);
    const items = (await second.request('session.history', { sessionId: id })).items;
    const texts = items.filter(item => item.event?.type === 'item').map(item => item.event.item.text);
    assert.ok(texts.some(entry => entry === 'codeword ALPHA') && !texts.some(entry => entry === 'codeword BRAVO'));
    assert.equal(items.filter(item => item.event?.type === 'item' && item.event.item.id === `rewind:${result.branch.branchId}`).length, 1, 'one marker');
    // The next reply sees only the kept turn; the source thread still has both; files are unchanged.
    await second.request('session.create', { sessionId: id, spec: { cwd: h.project, persist: true, model: MODEL }, resume: true });
    assert.equal(await h.codewords(second, id, 'ask-after'), 'codewords: ALPHA');
    assert.equal(await readFile(h.file, 'utf8'), 'kept as it is\n');
    const restored = await second.request('session.fork', { sessionId: id, requestId: 'restore', ifGeneration: result.generation, branchId: result.branch.branchId });
    await second.request('session.create', { sessionId: restored.session.id, spec: { cwd: h.project, persist: true, model: MODEL }, resume: true });
    assert.equal(await h.codewords(second, restored.session.id, 'ask-branch'), 'codewords: ALPHA BRAVO');
  });
}

test('fork killed before its record: the start finishes it from the journal, one native fork', { skip }, async t => {
  const h = await harness(t);
  const first = await h.start({ crashAt: 'fork.before-record' });
  const { id, turns, generation } = await h.conversation(first, ['codeword ALPHA', 'codeword BRAVO']);
  await assert.rejects(first.request('session.fork', { sessionId: id, requestId: 'fk', ifGeneration: generation, boundary: { throughTurnId: turns[0] }, newSessionId: 'forked' }));
  await first.crashed();
  const second = await h.start();
  t.after(() => second.stop());
  const result = await second.request('session.fork', { sessionId: id, requestId: 'fk', ifGeneration: generation, boundary: { throughTurnId: turns[0] }, newSessionId: 'forked' });
  assert.equal(result.duplicate, true);
  assert.equal(result.session.id, 'forked');
  assert.equal((await h.forks()).length, 1);
  await second.request('session.create', { sessionId: 'forked', spec: { cwd: h.project, persist: true, model: MODEL }, resume: true });
  assert.equal(await h.codewords(second, 'forked', 'ask-fork'), 'codewords: ALPHA');
  // The source can still see its later turn.
  await second.request('session.create', { sessionId: id, spec: { cwd: h.project, persist: true, model: MODEL }, resume: true });
  assert.equal(await h.codewords(second, id, 'ask-source'), 'codewords: ALPHA BRAVO');
  assert.equal(await readFile(h.file, 'utf8'), 'kept as it is\n');
});

test('a live root rewinds without a restart: the fork keeps the model, the next reply sees the prefix, receipts stay', { skip }, async t => {
  const h = await harness(t);
  const daemon = await h.start();
  t.after(() => daemon.stop());
  const { id, turns, generation } = await h.conversation(daemon, ['codeword ALPHA', 'codeword BRAVO', 'codeword CHARLIE']);
  const result = await daemon.request('session.rewind', { sessionId: id, requestId: 'live', ifGeneration: generation, beforeTurnId: turns[1] });
  assert.equal(result.branch.turns, 2);
  // One native fork, made with the session's model (Codex forks with its default otherwise).
  assert.equal((await h.forks()).length, 1);
  const forkState = (await readFile(h.stateFile, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)).find(entry => entry.type === 'fork');
  assert.equal(forkState.model, MODEL.replace(/^codex:/, ''));
  assert.deepEqual(forkState.turns.map(turn => turn.id), [turns[0]]);
  // The live session moved over: the next prompt goes to the fork without reopening.
  assert.equal(await h.codewords(daemon, id, 'ask-live'), 'codewords: ALPHA');
  // The prompt id of a set-aside turn is still a delivered one: nothing is sent.
  const before = (await h.journal()).filter(entry => entry.method === 'turn/start').length;
  assert.equal((await daemon.request('session.prompt', { sessionId: id, clientMessageId: 'm1', content: text('codeword BRAVO') })).duplicate, true);
  assert.equal((await h.journal()).filter(entry => entry.method === 'turn/start').length, before);
  // The old generation is stale for a second rewind.
  await assert.rejects(daemon.request('session.rewind', { sessionId: id, requestId: 'live-2', ifGeneration: generation, beforeTurnId: turns[1] }), rpcError(1004, 'stale_generation'));
});

test('a scheduled prompt a rewind set aside is not delivered again, before or after a restart', { skip }, async t => {
  const h = await harness(t);
  const daemon = await h.start();
  const { id } = await h.conversation(daemon, ['codeword ALPHA']);
  const { job } = await daemon.request('schedule.create', { projectRoot: h.project, sessionId: id, dueAt: new Date(Date.now() + 500).toISOString(), prompt: 'codeword BRAVO scheduled' });
  const delivered = async () => (await h.journal()).filter(entry => entry.method === 'turn/start' && entry.text?.includes('BRAVO scheduled')).length;
  await until(async () => (await daemon.request('schedule.get', { id: job.id, projectRoot: h.project })).job.status === 'delivered' && !(await daemon.request('session.get', { sessionId: id })).session.busy, 'the job delivered');
  const page = await daemon.request('session.history', { sessionId: id });
  const scheduledTurn = page.items.filter(item => item.event?.type === 'turn.started').at(-1).event.turnId;
  await daemon.request('session.rewind', { sessionId: id, requestId: 'past-job', ifGeneration: page.generation, beforeTurnId: scheduledTurn });
  assert.equal((await daemon.request('schedule.get', { id: job.id, projectRoot: h.project })).job.status, 'delivered');
  await daemon.stop();
  const again = await h.start();
  t.after(() => again.stop());
  // Two scheduler ticks (10 s each) later, the job was still delivered once.
  await sleep(21_000);
  assert.equal((await again.request('schedule.get', { id: job.id, projectRoot: h.project })).job.status, 'delivered');
  assert.equal(await delivered(), 1);
});
