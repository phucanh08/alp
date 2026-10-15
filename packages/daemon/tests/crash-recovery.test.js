// alpd killed at the points that decide what a prompt's delivery means (ALPD §66): a real alpd
// process with a fake Codex app-server, killed before and after its receipt and before and after
// the provider has the prompt, then restarted on the same home. No model is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { openSync, closeSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '@anhlp/alp-core/init';
import { connect, readLock } from '@anhlp/alp-client';

const ALPD = fileURLToPath(new URL('../dist/alpd.js', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('./support/fake-codex.js', import.meta.url));
const MODEL = 'codex:gpt-5.6-sol';
// The fake provider is a Node script run as an executable, and the crashed group is a POSIX process group.
const skip = process.platform === 'win32' && 'POSIX processes only';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
async function until(check, what) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await sleep(25); }
  assert.fail(`${what} did not happen`);
}
const text = body => [{ type: 'text', text: body }];

/** A home and project for one test, and alpd processes started on them one after another. */
async function harness(t, { settings = {} } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alpd-crash-'));
  const home = path.join(directory, 'home');
  await mkdir(home, { mode: 0o700 });
  await writeFile(path.join(home, 'settings.json'), JSON.stringify(settings));
  const project = path.join(directory, 'project');
  await initProject(project);
  // Main alone, on the fake Codex: no supervisor beside it.
  await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ workflow: { supervisor: false } }));
  const journalFile = path.join(directory, 'provider.jsonl');
  const logFile = path.join(directory, 'alpd.log');
  const started = [];

  async function journal() {
    return (await readFile(journalFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  }

  /** Starts alpd as a detached process group leader, as `alpd --detach` and service managers do. */
  async function start({ crashAt, env = {} } = {}) {
    const log = openSync(logFile, 'a');
    const child = spawn(process.execPath, [ALPD], {
      detached: true,
      stdio: ['ignore', log, log],
      env: { ...process.env, ALP_HOME: home, ALP_CODEX_BIN: FAKE_CODEX, FAKE_CODEX_JOURNAL: journalFile, ...(crashAt ? { ALP_TEST_CRASH_AT: crashAt } : {}), ...env },
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
    const client = await connect((await readLock(home)).socket, { name: 'crash-test', version: '0' });
    const events = [];
    client.onEvent(envelope => events.push(envelope));
    return {
      pid: child.pid, client, events, exited,
      request: (method, params) => client.request(method, params),
      /** Kills alpd as a crash would and waits for it to go. */
      async kill() { process.kill(child.pid, 'SIGKILL'); await exited; client.close(); },
      async crashed() { const result = await exited; client.close(); assert.equal(result.signal, 'SIGKILL'); },
      async stop() { await client.request('daemon.shutdown').catch(() => {}); client.close(); await exited; },
    };
  }

  t.after(async () => {
    for (const child of started) if (child.exitCode === null && child.signalCode === null) try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    for (const { pid } of await journal()) if (alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch {}
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  return {
    home, project, journal, logFile,
    start,
    /** The turn/starts the provider received that carry `marker`, across every provider process. */
    async received(marker) { return (await journal()).filter(entry => entry.method === 'turn/start' && entry.text?.includes(marker)); },
    create: (daemon, params = {}) => daemon.request('session.create', { spec: { cwd: project, persist: true, model: MODEL }, ...params }),
    timelineFile: sessionId => path.join(home, 'state', 'timeline', `${sessionId}.jsonl`),
  };
}

const outcomeUnknown = error => error?.code === 1004 && error.data?.reason === 'outcome_unknown';

test('killed before the pending receipt: nothing was recorded or sent, and the same id sends once after restart', { skip }, async t => {
  const h = await harness(t);
  const first = await h.start({ crashAt: 'prompt.before-receipt' });
  const { session } = await h.create(first);
  await assert.rejects(first.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('alpha') }));
  await first.crashed();
  assert.deepEqual(await h.received('alpha'), []);

  const second = await h.start();
  t.after(() => second.stop());
  await h.create(second, { sessionId: session.id });
  assert.deepEqual(await second.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('alpha') }), { outcome: 'accepted', durable: true });
  assert.equal((await h.received('alpha')).length, 1);
});

test('killed after the pending receipt, before sending: outcome unknown, never sent by itself', { skip }, async t => {
  const h = await harness(t);
  const first = await h.start({ crashAt: 'prompt.after-receipt' });
  const { session } = await h.create(first);
  await assert.rejects(first.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('bravo') }));
  await first.crashed();

  const second = await h.start();
  t.after(() => second.stop());
  await h.create(second, { sessionId: session.id });
  await assert.rejects(second.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('bravo') }), outcomeUnknown);
  // alpd cannot tell this window from the next one, so it answers the same: the client decides.
  assert.deepEqual(await h.received('bravo'), []);
  assert.equal((await second.request('session.prompt', { sessionId: session.id, clientMessageId: 'm2', content: text('bravo again') })).outcome, 'accepted');
  assert.equal((await h.received('bravo')).length, 1);
});

test('killed while the provider has the prompt but has not answered: outcome unknown, sent exactly once', { skip }, async t => {
  const h = await harness(t);
  const first = await h.start();
  const { session } = await h.create(first);
  // The fake provider records the turn, then kills alpd before it answers.
  await assert.rejects(first.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('charlie [kill-parent]') }));
  await first.crashed();
  assert.equal((await h.received('charlie')).length, 1);

  const second = await h.start();
  t.after(() => second.stop());
  const { sessions } = await second.request('session.list', { includeClosed: true });
  // It never became a running turn, so nothing reopens or continues it.
  assert.equal(sessions.find(row => row.id === session.id).status, 'closed');
  await h.create(second, { sessionId: session.id });
  await assert.rejects(second.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('charlie [kill-parent]') }), outcomeUnknown);
  assert.equal((await second.request('session.prompt', { sessionId: session.id, clientMessageId: 'm2', content: text('delta') })).outcome, 'accepted');
  assert.equal((await h.received('charlie')).length, 1);
});

test('killed after the provider accepted, before the receipt completed: the timeline settles it as delivered', { skip }, async t => {
  const h = await harness(t, { settings: { recovery: { autoResume: false } } });
  const first = await h.start({ crashAt: 'prompt.after-send' });
  const { session } = await h.create(first);
  await assert.rejects(first.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('echo [hold]') }));
  await first.crashed();
  assert.equal((await h.received('echo')).length, 1);
  const pending = JSON.parse(await readFile(path.join(h.home, 'state', 'receipts', (await readdir(path.join(h.home, 'state', 'receipts')))[0]), 'utf8'));
  assert.equal(pending.state, 'pending');

  const second = await h.start();
  t.after(() => second.stop());
  // The interrupted turn is reported, and with recovery parked the root does not continue by itself.
  await until(async () => (await second.request('session.list', { includeClosed: true })).sessions.find(row => row.id === session.id)?.parked, 'the root to reopen parked');
  await second.request('session.attach', { sessionId: session.id });
  await until(() => second.events.some(e => e.event.type === 'turn.ended' && e.event.state === 'failed' && e.event.error?.code === 'daemon_restarted'), 'the interrupted turn in the replay');
  assert.deepEqual(await second.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('echo [hold]') }), { outcome: 'accepted', duplicate: true, durable: true });
  assert.equal((await h.received('echo')).length, 1);
  assert.equal((await h.journal()).filter(entry => entry.method === 'turn/start').length, 1, 'no recovery prompt while recovery is parked');
});

test('killed after the receipt completed: a retry is a duplicate', { skip }, async t => {
  const h = await harness(t);
  const first = await h.start({ crashAt: 'prompt.after-completed' });
  const { session } = await h.create(first);
  await assert.rejects(first.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('foxtrot') }));
  await first.crashed();

  const second = await h.start();
  t.after(() => second.stop());
  await h.create(second, { sessionId: session.id });
  assert.deepEqual(await second.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('foxtrot') }), { outcome: 'accepted', duplicate: true, durable: true });
  await assert.rejects(second.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('other') }), error => error.code === 1004 && error.data?.reason === 'key_conflict');
  assert.equal((await h.received('foxtrot')).length, 1);
});

test('killed mid-turn: the provider exits, the turn is reported interrupted, and the root continues once with a notice', { skip }, async t => {
  const h = await harness(t);
  const first = await h.start();
  const { session } = await h.create(first);
  assert.equal((await first.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('golf [hold]') })).outcome, 'accepted');
  const [{ pid: provider }] = await h.received('golf');
  await first.kill();
  // Its stdin closed with alpd, so the provider exited by itself.
  await until(() => !alive(provider), 'the provider to exit');
  assert.ok((await h.journal()).some(entry => entry.pid === provider && entry.method === 'eof'));

  const second = await h.start();
  t.after(() => second.stop());
  await until(async () => (await h.journal()).some(entry => entry.method === 'turn/start' && /alpd stopped unexpectedly during your turn/.test(entry.text ?? '')), 'the recovery prompt');
  assert.equal((await h.received('golf')).length, 1, 'the user prompt is not sent again');
  assert.equal((await h.journal()).filter(entry => entry.method === 'turn/start' && /during your turn/.test(entry.text ?? '')).length, 1);
  assert.deepEqual(await second.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('golf [hold]') }), { outcome: 'accepted', duplicate: true, durable: true });
  const status = await second.request('daemon.status');
  assert.equal(status.previousExit.kind, 'crash');
  assert.deepEqual(status.persistence, { ok: true, failures: 0 });
});

test('a provider that outlives a crash is stopped by the next alpd before it recovers anything', { skip }, async t => {
  const h = await harness(t, { settings: { recovery: { autoResume: false } } });
  const first = await h.start({ env: { FAKE_CODEX_IGNORE_EOF: '1' } });
  const { session } = await h.create(first);
  await first.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('hotel [hold]') });
  const [{ pid: provider }] = await h.received('hotel');
  await first.kill();
  await until(async () => (await h.journal()).some(entry => entry.pid === provider && entry.method === 'eof'), 'the provider to see alpd go');
  assert.ok(alive(provider), 'a stuck provider keeps running after alpd crashed');

  const second = await h.start();
  t.after(() => second.stop());
  // Ready means the leftover group was already ended.
  await until(() => !alive(provider), 'the leftover provider to stop');
  assert.ok((await h.journal()).some(entry => entry.pid === provider && entry.method === 'sigterm'));
  assert.match(await readFile(h.logFile, 'utf8'), new RegExp(`stopping processes the previous alpd \\(pid ${first.pid}\\) left running`));
});

test('a provider dying mid-request answers outcome unknown, and the same id is not sent again', { skip }, async t => {
  const h = await harness(t);
  const daemon = await h.start();
  t.after(() => daemon.stop());
  const { session } = await h.create(daemon);
  await assert.rejects(daemon.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('india [die]') }), outcomeUnknown);
  await assert.rejects(daemon.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('india [die]') }), outcomeUnknown);
  assert.equal((await h.received('india')).length, 1);
  assert.ok(daemon.events.some(e => e.event.type === 'prompt.failed' && e.event.error.code === 'outcome_unknown'));
});

test('a timeline line cut short by a crash is dropped; cursors keep increasing across restarts and attach replays from a cursor', { skip }, async t => {
  const h = await harness(t, { settings: { recovery: { autoResume: false } } });
  const first = await h.start();
  const { session } = await h.create(first);
  await first.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('juliet') });
  await until(() => first.events.some(e => e.event.type === 'turn.ended'), 'the first turn to end');
  const seen = first.events.at(-1).cursor;
  assert.deepEqual(first.events.map(e => e.cursor), Array.from({ length: first.events.length }, (_, i) => i + 1));
  await first.request('session.prompt', { sessionId: session.id, clientMessageId: 'm2', content: text('kilo [hold]') });
  await until(() => first.events.some(e => e.event.type === 'turn.started' && e.cursor > seen), 'the second turn to start');
  await first.kill();
  // As a crash in the middle of an append leaves it.
  await appendFile(h.timelineFile(session.id), '{"sessionId":"' + session.id + '","epoch":"x","seq":99,"ev');

  const second = await h.start();
  t.after(() => second.stop());
  await until(async () => (await second.request('session.list', { includeClosed: true })).sessions.find(row => row.id === session.id)?.parked, 'the root to reopen parked');
  // A client that saw everything up to `seen` gets only what came after, in order, the interruption included.
  const { cursor } = await second.request('session.attach', { sessionId: session.id, after: seen });
  const replayed = second.events.filter(e => e.sessionId === session.id);
  assert.ok(replayed.length > 0 && replayed.every(e => e.cursor > seen));
  assert.deepEqual(replayed.map(e => e.cursor), [...replayed.map(e => e.cursor)].sort((a, b) => a - b));
  assert.ok(replayed.some(e => e.event.type === 'turn.ended' && e.event.error?.code === 'daemon_restarted'));
  assert.ok(replayed.some(e => e.event.type === 'item' && e.event.item.text === 'kilo [hold]'));
  assert.equal(cursor, replayed.at(-1).cursor);

  // Every line of the timeline is whole again, and its cursors strictly increase.
  const lines = (await readFile(h.timelineFile(session.id), 'utf8')).split('\n');
  assert.equal(lines.at(-1), '');
  const cursors = lines.filter(Boolean).map(line => JSON.parse(line).cursor);
  for (let i = 1; i < cursors.length; i++) assert.ok(cursors[i] > cursors[i - 1], `cursor ${cursors[i]} after ${cursors[i - 1]}`);
  assert.match(await readFile(h.logFile, 'utf8'), /removed a timeline line cut short/);

  // A cursor this tree never reached: the whole timeline, marked as a reset.
  const other = await connect((await readLock(h.home)).socket, { name: 'late', version: '0' });
  t.after(() => other.close());
  const events = [];
  other.onEvent(envelope => events.push(envelope));
  const reset = await other.request('session.attach', { sessionId: session.id, after: cursors.at(-1) + 1000 });
  assert.equal(reset.reset, true);
  assert.equal(events[0].cursor, 1);
});
