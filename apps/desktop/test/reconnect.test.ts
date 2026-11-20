import { describe, expect, test } from 'bun:test';
import type { Connect } from '../src/dashboard';
import { DEFAULTS, Reconnector, type Timers } from '../src/reconnect';
import type { DashboardAddress } from '../src/url';

const TOKEN = `alpgw1.${'a'.repeat(16)}.${'b'.repeat(43)}`;
const address = (port: number, token = TOKEN): DashboardAddress => ({ url: `http://127.0.0.1:${port}/#token=${token}`, origin: `http://127.0.0.1:${port}` });
const A = address(7433);
const MOVED = address(7434);
const ROTATED = address(7433, `alpgw1.${'c'.repeat(16)}.${'d'.repeat(43)}`);

/** Timers that run only when the test advances the clock; promises settle between callbacks. */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const queue = new Map<number, { at: number; fn: () => void }>();
  const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const timers: Timers = {
    set: (fn, ms) => { const id = ++seq; queue.set(id, { at: now + ms, fn }); return id; },
    clear: id => { queue.delete(id as number); },
    now: () => now,
  };
  async function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      await flush();
      const due = [...queue.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      queue.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = end;
    await flush();
  }
  return { timers, advance, pending: () => queue.size };
}

function setup(options: { up?: () => boolean; resolve?: () => Connect | Promise<Connect> } = {}) {
  const clock = fakeTimers();
  const calls = { resolve: 0, probe: 0, loads: [] as DashboardAddress[], giveUps: [] as { result: Connect | undefined; message: string }[] };
  let up = options.up ?? (() => true);
  let resolveWith = options.resolve ?? ((): Connect => ({ ok: true, address: A }));
  const reconnector = new Reconnector({
    resolve: async () => { calls.resolve++; return resolveWith(); },
    probe: async () => { calls.probe++; return up(); },
    load: a => { calls.loads.push(a); },
    giveUp: (result, message) => { calls.giveUps.push({ result, message }); },
    timers: clock.timers,
  });
  return {
    reconnector, calls, clock,
    setUp: (f: () => boolean) => { up = f; },
    setResolve: (f: () => Connect | Promise<Connect>) => { resolveWith = f; },
  };
}

const POLL = DEFAULTS.pollMs;

describe('Reconnector', () => {
  test('idle until a page loads: no probe, triggers ignored', async () => {
    const { reconnector, calls, clock } = setup();
    reconnector.trigger('down');
    reconnector.trigger('load-failed');
    await clock.advance(60_000);
    expect(calls).toMatchObject({ resolve: 0, probe: 0, loads: [] });
    expect(reconnector.state).toBe('idle');
  });

  test('a healthy page is probed every poll interval, one probe at a time, and nothing else happens', async () => {
    const { reconnector, calls, clock } = setup();
    reconnector.loaded(A);
    await clock.advance(POLL * 5);
    expect(calls.probe).toBe(5);
    expect(calls.resolve).toBe(0);
    expect(reconnector.state).toBe('watching');
  });

  test('one failed probe is not enough; two in a row start a recovery after the first backoff', async () => {
    const answers = [false, true, false, false];
    const { reconnector, calls, clock } = setup({ up: () => answers.shift() ?? true });
    reconnector.loaded(A);
    await clock.advance(POLL * 2);
    expect(reconnector.state).toBe('watching');
    await clock.advance(POLL * 2);
    expect(reconnector.state).toBe('waiting');
    expect(calls.resolve).toBe(0);
    await clock.advance(DEFAULTS.backoffMs[0]);
    expect(calls.resolve).toBe(1);
  });

  test('alp dashboard restarted on a new port: the new address is loaded, and watching resumes once it loads', async () => {
    const { reconnector, calls, clock, setUp, setResolve } = setup();
    reconnector.loaded(A);
    setUp(() => false);
    setResolve(() => ({ ok: true, address: MOVED }));
    await clock.advance(POLL * 2 + DEFAULTS.backoffMs[0]);
    expect(calls.loads).toEqual([MOVED]);
    expect(reconnector.state).toBe('loading');
    setUp(() => true);
    reconnector.loaded(MOVED);
    expect(reconnector.state).toBe('watching');
    const probes = calls.probe;
    await clock.advance(POLL);
    expect(calls.probe).toBe(probes + 1);
  });

  test('alp dashboard back on the same address and token: no reload, the page reconnects by itself', async () => {
    let upNow = true;
    const { reconnector, calls, clock, setUp } = setup({ up: () => upNow });
    reconnector.loaded(A);
    upNow = false;
    await clock.advance(POLL * 2);
    upNow = true;
    setUp(() => upNow);
    await clock.advance(DEFAULTS.backoffMs[0]);
    expect(calls.resolve).toBe(1);
    expect(calls.loads).toEqual([]);
    expect(reconnector.state).toBe('watching');
  });

  test('a rotated token (401 from the page) loads the new address alp prints', async () => {
    const { reconnector, calls, clock } = setup({ resolve: () => ({ ok: true, address: ROTATED }) });
    reconnector.loaded(A);
    reconnector.trigger('token-rejected');
    await clock.advance(DEFAULTS.backoffMs[0]);
    expect(calls.loads).toEqual([ROTATED]);
  });

  test('a refused token that alp still prints is given up at once, not reloaded', async () => {
    const { reconnector, calls, clock } = setup();
    reconnector.loaded(A);
    reconnector.trigger('token-rejected');
    await clock.advance(DEFAULTS.backoffMs[0]);
    expect(calls.loads).toEqual([]);
    expect(calls.giveUps).toHaveLength(1);
    expect(calls.giveUps[0].message).toContain('alp dashboard rotate');
    expect(reconnector.state).toBe('idle');
    await clock.advance(120_000);
    expect(calls.resolve).toBe(1);
  });

  test('triggers during a recovery are dropped: one alp dashboard --print at a time (debounce)', async () => {
    let finish: (value: Connect) => void = () => {};
    const { reconnector, calls, clock } = setup({ up: () => false, resolve: () => new Promise<Connect>(r => { finish = r; }) });
    reconnector.loaded(A);
    for (let i = 0; i < 10; i++) { reconnector.trigger('down'); reconnector.trigger('token-rejected'); reconnector.loadFailed(); }
    expect(reconnector.state).toBe('waiting');
    await clock.advance(DEFAULTS.backoffMs[0]);
    expect(reconnector.state).toBe('resolving');
    for (let i = 0; i < 10; i++) reconnector.trigger('down');
    await clock.advance(60_000);
    expect(calls.resolve).toBe(1);
    finish({ ok: true, address: MOVED });
    await clock.advance(0);
    expect(calls.loads).toEqual([MOVED]);
  });

  test('a load that keeps failing backs off 1, 2, 4, 8, 16, 30, 30 s and gives up after maxAttempts', async () => {
    const { reconnector, calls, clock } = setup({ up: () => false, resolve: () => ({ ok: true, address: MOVED }) });
    reconnector.loaded(A);
    await clock.advance(POLL * 2);
    const times: number[] = [];
    const start = clock.timers.now();
    for (let i = 0; i < DEFAULTS.maxAttempts; i++) {
      const before = calls.loads.length;
      // Step 100 ms at a time until the next load starts, and note when.
      while (calls.loads.length === before) await clock.advance(100);
      times.push(clock.timers.now() - start);
      reconnector.loadFailed();
    }
    const gaps = times.map((t, i) => t - (times[i - 1] ?? 0));
    expect(gaps).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    expect(calls.giveUps).toHaveLength(1);
    expect(calls.giveUps[0].message).toContain('Connect again');
    expect(reconnector.state).toBe('idle');
    await clock.advance(600_000);
    expect(calls.resolve).toBe(DEFAULTS.maxAttempts);
  });

  test('alp failing keeps retrying with backoff, then hands alp\'s error to giveUp', async () => {
    const { reconnector, calls, clock } = setup({ up: () => false, resolve: () => ({ ok: false, error: 'alp dashboard is disabled' }) });
    reconnector.loaded(A);
    await clock.advance(POLL * 2 + 200_000);
    expect(calls.resolve).toBe(DEFAULTS.maxAttempts);
    expect(calls.giveUps).toEqual([{ result: { ok: false, error: 'alp dashboard is disabled' }, message: '' }]);
  });

  test('missing alp is given up at the first attempt', async () => {
    const { reconnector, calls, clock } = setup({ up: () => false, resolve: () => ({ ok: false, missing: true }) });
    reconnector.loaded(A);
    await clock.advance(POLL * 2 + DEFAULTS.backoffMs[0]);
    expect(calls.resolve).toBe(1);
    expect(calls.giveUps[0].result).toEqual({ ok: false, missing: true });
  });

  test('a page that fails again at once does not reset the count (no storm); one stable for a minute does', async () => {
    let upNow = true;
    const { reconnector, calls, clock } = setup({ up: () => upNow, resolve: () => ({ ok: true, address: MOVED }) });
    reconnector.loaded(A);
    upNow = false;
    await clock.advance(POLL * 2 + 1000);
    expect(reconnector.attempts).toBe(1);
    reconnector.loaded(MOVED);
    // Fails again within seconds: the next wait is 2 s, not 1 s.
    await clock.advance(POLL * 2);
    expect(reconnector.state).toBe('waiting');
    await clock.advance(1000);
    expect(calls.resolve).toBe(1);
    await clock.advance(1000);
    expect(calls.resolve).toBe(2);
    expect(reconnector.attempts).toBe(2);
    upNow = true;
    reconnector.loaded(MOVED);
    await clock.advance(DEFAULTS.stableMs);
    upNow = false;
    await clock.advance(POLL * 2);
    expect(reconnector.state).toBe('waiting');
    expect(reconnector.attempts).toBe(0);
    await clock.advance(1000);
    expect(calls.resolve).toBe(3);
  });

  test('stop() cancels a pending attempt and drops the result of a running one', async () => {
    let finish: (value: Connect) => void = () => {};
    const { reconnector, calls, clock } = setup({ up: () => false, resolve: () => new Promise<Connect>(r => { finish = r; }) });
    reconnector.loaded(A);
    await clock.advance(POLL * 2);
    reconnector.stop();
    await clock.advance(60_000);
    expect(calls.resolve).toBe(0);
    reconnector.loaded(A);
    await clock.advance(POLL * 2 + 1000);
    expect(calls.resolve).toBe(1);
    reconnector.stop();
    finish({ ok: true, address: MOVED });
    await clock.advance(60_000);
    expect(calls.loads).toEqual([]);
    expect(calls.giveUps).toEqual([]);
    expect(clock.pending()).toBe(0);
  });

  test('a reload that loads while a recovery waits does not cancel it', async () => {
    const { reconnector, calls, clock } = setup({ up: () => false, resolve: () => ({ ok: true, address: MOVED }) });
    reconnector.loaded(A);
    await clock.advance(POLL * 2);
    reconnector.loaded(A);
    expect(reconnector.state).toBe('waiting');
    await clock.advance(1000);
    expect(calls.loads).toEqual([MOVED]);
  });

  test('a 401 for the page being loaded leads to the next attempt, and the new page loading ends it watching', async () => {
    const { reconnector, calls, clock } = setup({ up: () => false, resolve: () => ({ ok: true, address: ROTATED }) });
    reconnector.loaded(A);
    reconnector.trigger('token-rejected');
    await clock.advance(1000);
    expect(reconnector.state).toBe('loading');
    reconnector.loaded(ROTATED);
    expect(reconnector.state).toBe('watching');
    expect(calls.giveUps).toEqual([]);
  });

  test('a load that neither finishes nor fails within loadTimeoutMs counts as failed', async () => {
    const { reconnector, calls, clock } = setup({ up: () => false, resolve: () => ({ ok: true, address: MOVED }) });
    reconnector.loaded(A);
    await clock.advance(POLL * 2 + 1000);
    expect(calls.loads).toHaveLength(1);
    expect(reconnector.state).toBe('loading');
    await clock.advance(DEFAULTS.loadTimeoutMs - 1);
    expect(reconnector.state).toBe('loading');
    await clock.advance(1);
    expect(reconnector.state).toBe('waiting');
    await clock.advance(2000);
    expect(calls.loads).toHaveLength(2);
  });

  test('a reload while watching keeps the attempt count; only a stable minute or a fresh start resets it', async () => {
    let upNow = true;
    const { reconnector, clock } = setup({ up: () => upNow, resolve: () => ({ ok: true, address: MOVED }) });
    reconnector.loaded(A);
    upNow = false;
    await clock.advance(POLL * 2 + 1000);
    upNow = true;
    reconnector.loaded(MOVED);
    expect(reconnector.attempts).toBe(1);
    reconnector.loaded(MOVED);
    expect(reconnector.attempts).toBe(1);
    reconnector.stop();
    reconnector.loaded(MOVED);
    expect(reconnector.attempts).toBe(0);
  });

  test('a probe that throws counts as no answer', async () => {
    const { reconnector, clock, setUp } = setup();
    setUp(() => { throw new Error('boom'); });
    reconnector.loaded(A);
    await clock.advance(POLL * 2);
    expect(reconnector.state).toBe('waiting');
  });
});
