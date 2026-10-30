import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { follow, interruptTurn, Run } from '../../scripts/beta-acceptance-lib.mjs';

// Real child stdout, including multiple envelopes in one chunk, rather than a mocked next().
async function fixture(t, events, { hold = false, afterInterrupt, resistTermination = false, startupDelay = 0 } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'alp-c5-'));
  const script = path.join(dir, 'stream.cjs');
  const trigger = path.join(dir, 'interrupt');
  const tail = afterInterrupt ? `const fs = require('node:fs'); const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(trigger)})) return;
    clearInterval(timer); console.log(${JSON.stringify(JSON.stringify(end(afterInterrupt)))});
  }, 5); setTimeout(() => { clearInterval(timer); }, 10_000).unref();` : hold ? 'setTimeout(() => {}, 1000);' : '';
  const gate = path.join(dir, 'ready');
  const startup = startupDelay ? `const fsGate = require('node:fs'); const gateTimer = setInterval(() => {
    if (!fsGate.existsSync(${JSON.stringify(gate)})) return;
    clearInterval(gateTimer); emit();
  }, 5);` : 'emit();';
  writeFileSync(script, `${resistTermination ? "process.on('SIGTERM', () => {});" : ''}function emit() { console.log(${JSON.stringify(events.map(e => JSON.stringify(e)).join('\n'))});${tail} } ${startup}`);
  const stream = follow({ log() {} }, 'fixture', ['run'], { alp: script, cwd: dir, env: process.env });
  const release = startupDelay ? setTimeout(() => writeFileSync(gate, 'ready'), startupDelay) : undefined;
  t.after(async () => { clearTimeout(release); stream.child.kill(); await stream.exit.catch(() => {}); rmSync(dir, { recursive: true, force: true }); });
  stream.interrupt = () => writeFileSync(trigger, 'interrupt');
  return stream;
}
const event = (type, extra = {}, sessionId = 'root') => ({ sessionId, event: { type, ...extra } });
const opened = event('session.opened', { session: {} });
const started = event('turn.started', { turnId: 'initial', origin: 'user' });
const end = state => event('turn.ended', { turnId: 'initial', state });

test('C5 fast completed turn is inconclusive without sending interrupt', async t => {
  const stream = await fixture(t, [opened, started, end('completed')]);
  let calls = 0;
  const result = await interruptTurn(stream, () => { calls++; }, { timeout: 2000 });
  assert.equal(result.status, 'pending');
  assert.equal(calls, 0);
});

test('C5 buffered cancellation before dispatch is not proof of interrupt', async t => {
  const stream = await fixture(t, [opened, started, end('canceled')]);
  await assert.rejects(interruptTurn(stream, () => {}, { timeout: 2000 }), /before interrupt/);
});

test('C5 failure is an immediate failure, never inconclusive', async t => {
  const stream = await fixture(t, [opened, started, end('failed')]);
  await assert.rejects(interruptTurn(stream, () => {}, { timeout: 2000 }), /failed/);
});

test('C5 ignores child and other root-turn cancellation and times out', async t => {
  const stream = await fixture(t, [opened, started,
    event('turn.ended', { turnId: 'initial', state: 'canceled' }, 'supervisor'),
    event('turn.ended', { turnId: 'other', state: 'canceled' })], { hold: true });
  await stream.next(e => e.event.type === 'turn.started', 'start', 2000);
  await assert.rejects(interruptTurn(stream, () => {}, { timeout: 150 }), /no .*within/);
});

test('C5 inconclusive blocks a live gate', () => {
  assert.equal(Run.prototype.verdict.call({ mode: 'live', latest: () => [{ status: 'pending' }] }), 'pending');
});

test('C5 fake hold: matching cancellation after dispatch passes', async t => {
  const stream = await fixture(t, [opened, started], { afterInterrupt: 'canceled' });
  const result = await interruptTurn(stream, stream.interrupt, { timeout: 500 });
  assert.equal(result.status, 'canceled');
  assert.equal(result.turnId, 'initial');
  assert.equal(result.code, 0);
});

for (const state of ['completed', 'failed']) test(`C5 ${state} after dispatch fails without retry`, async t => {
  const stream = await fixture(t, [opened, started,
    event('item', { item: { kind: 'assistant_message', text: '1' } })], { afterInterrupt: state });
  let calls = 0;
  await assert.rejects(interruptTurn(stream, () => { calls++; stream.interrupt(); }, { timeout: 500, waitForOutput: true }), new RegExp(`after interrupt.*${state}`));
  assert.equal(calls, 1);
});

test('C5 live completion without output stays pending and stops viewer', async t => {
  const stream = await fixture(t, [opened, started, end('completed')], { hold: true, startupDelay: 250 });
  // Child startup is independent of C5's behavior budget. Deliberately gate the
  // fixture beyond 200 ms so this also covers a contended combined test run.
  await stream.next(e => e.event.type === 'turn.started', 'fixture ready', 2000);
  const result = await interruptTurn(stream, () => assert.fail('must not interrupt'), { timeout: 200, waitForOutput: true });
  assert.equal(result.status, 'pending');
  assert.ok(stream.child.exitCode !== null || stream.child.signalCode !== null);
});

test('C5 interrupt command failure stops viewer and fails', async t => {
  const stream = await fixture(t, [opened, started], { hold: true, startupDelay: 250 });
  // Keep real child startup outside the command-failure behavior budget.
  await stream.next(e => e.event.type === 'turn.started', 'fixture ready', 2000);
  await assert.rejects(interruptTurn(stream, () => { throw new Error('command failed'); }, { timeout: 200 }), /command failed/);
  assert.ok(stream.child.exitCode !== null || stream.child.signalCode !== null);
});

test('follow missing event after close rejects immediately; timed-out waits do not consume later matches', async t => {
  const stream = await fixture(t, [opened, started], { afterInterrupt: 'canceled' });
  // Child startup and the fixture's 5 ms polling are not what this test measures: give them room
  // on a loaded machine (t-e706). The fixture keeps polling for the interrupt for 10 s.
  await stream.next(e => e.event.type === 'turn.started', 'start', 5000);
  const terminal = e => e.event.type === 'turn.ended';
  await assert.rejects(stream.next(terminal, 'end', 20), /no end within/);
  const next = stream.next(terminal, 'end', 5000);
  stream.interrupt();
  assert.equal((await next).event.state, 'canceled');
  await stream.exit;
  await assert.rejects(stream.next(() => false, 'missing', 10000), /exited before missing/);
});

test('follow stop escalates a SIGTERM-resistant viewer within a deadline', { skip: process.platform === 'win32' && 'Windows terminates children forcibly; POSIX signal behavior only' }, async t => {
  const stream = await fixture(t, [opened, started], { afterInterrupt: 'canceled', resistTermination: true });
  await stream.next(e => e.event.type === 'turn.started', 'start', 2000);
  const before = Date.now();
  await stream.stop({ graceMs: 50, forceMs: 500 });
  assert.ok(Date.now() - before < 1500);
  assert.equal(stream.child.signalCode, 'SIGKILL');
});
