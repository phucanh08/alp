import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { createDaemonServer } from '@anhlp/alp-daemon';

function transport(readings, calls) {
  return (_cwd, _env, runtime) => ({
    async initialize() { calls.push(`${runtime}:initialize`); },
    onNotification() {}, onFailure() {}, onRequest() {}, async request() { throw new Error('Usage must not start a turn'); },
    async orchestrationContext() { calls.push(`${runtime}:usage`); return { usage: readings[runtime] }; },
    async close() { calls.push(`${runtime}:close`); },
  });
}

test('daemon usage normalizes provider windows, strips account data and shares concurrent reads', async t => {
  const calls = [];
  const runtime = createAlpRuntime({ transport: transport({
    codex: { available: true, email: 'private@example.com', ordinaryUsageAllowed: true, limits: [{ name: 'Codex', plan: 'pro', windows: [{ usedPercent: 42, windowMinutes: 300, resetsAt: 1_800_000_000 }, { usedPercent: 110, windowMinutes: 10080, resetsAt: 'invalid' }] }] },
    claude: { available: true, plan: 'max', windows: [{ name: 'five_hour', usedPercent: 17.5, resetsAt: '2027-01-15T08:00:00Z' }, { name: 'seven_day', usedPercent: NaN }] },
  }, calls), supervisor: false });
  t.after(() => runtime.shutdown());
  const daemon = createDaemonServer({ runtime, socketPath: '', version: 'test' });
  const client = daemon.local();
  t.after(() => client.close());
  const [first, second] = await Promise.all([client.request('daemon.usage'), client.request('daemon.usage')]);
  assert.deepEqual(first, second);
  assert.deepEqual(first.providers.map(provider => [provider.runtime, provider.plan, provider.limited]), [['codex', 'pro', true], ['claude', 'max', false]]);
  assert.deepEqual(first.providers[0].windows, [
    { name: 'Codex · 5 hour window', usedPercent: 42, resetsAt: '2027-01-15T08:00:00.000Z' },
    { name: 'Codex · 7 day window', usedPercent: 100, resetsAt: null },
  ]);
  assert.equal(first.providers[1].windows[1].usedPercent, null);
  assert.doesNotMatch(JSON.stringify(first), /private@example|email/);
  assert.equal(calls.filter(call => call.endsWith(':usage')).length, 2);
  assert.equal(calls.filter(call => call.endsWith(':close')).length, 2);
  runtime.pause({ runtime: 'codex', reason: 'Taking a break' });
  const paused = await client.request('daemon.usage');
  assert.equal(paused.providers[0].pause.reason, 'Taking a break');
  assert.equal(paused.providers[1].pause, null);
  assert.equal(calls.filter(call => call.endsWith(':usage')).length, 2, 'pause state is fresh without probing again');
});

test('usage reports unavailable providers without inventing zero percent', async t => {
  const calls = [];
  const runtime = createAlpRuntime({ transport: transport({ codex: { available: false } }, calls), supervisor: false });
  t.after(() => runtime.shutdown());
  const { providers } = await runtime.usage();
  assert.ok(providers.every(provider => !provider.available && provider.windows.length === 0 && provider.plan === null));
});

test('explicit refresh bypasses the usage cache but concurrent refreshes share a probe', async t => {
  const calls = [];
  const readings = { codex: { available: false }, claude: { available: false } };
  const runtime = createAlpRuntime({ transport: transport(readings, calls), supervisor: false });
  t.after(() => runtime.shutdown());
  assert.equal((await runtime.usage()).providers[0].available, false);
  readings.codex = { available: true, limits: [{ windows: [{ usedPercent: 25, windowMinutes: 300 }] }] };
  assert.equal((await runtime.usage()).providers[0].available, false);
  const [first, second] = await Promise.all([runtime.usage(true), runtime.usage(true)]);
  assert.deepEqual(first, second);
  assert.equal(first.providers[0].windows[0].usedPercent, 25);
  assert.equal(calls.filter(call => call.endsWith(':usage')).length, 4);
});
