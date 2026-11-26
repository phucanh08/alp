import assert from 'node:assert/strict';
import test from 'node:test';
import { readUsage, setUsageSetting, USAGE_EVENT } from '../dist-lib/owner-host.js';
import type { OwnerController } from '../dist-lib/owner-host.js';

// A browser's window is an EventTarget; node's globalThis is not, so give it one for these tests.
// any: node's globalThis takes the EventTarget methods a browser window has.
const g = globalThis as any;
if (typeof g.addEventListener !== 'function') {
  const target = new EventTarget();
  g.addEventListener = target.addEventListener.bind(target);
  g.removeEventListener = target.removeEventListener.bind(target);
  g.dispatchEvent = target.dispatchEvent.bind(target);
}

/** Collects the usage announcements made while `run` runs (t-9116: the sidebar listens to them). */
async function announced(run: () => Promise<unknown>) {
  const seen: unknown[] = [];
  const listener = (event: Event) => seen.push((event as CustomEvent).detail);
  globalThis.addEventListener(USAGE_EVENT, listener);
  try { await run(); } finally { globalThis.removeEventListener(USAGE_EVENT, listener); }
  return seen;
}

const controller = (answers: Record<string, unknown>) => ({ ownerRequest: async (method: string) => answers[method] }) as OwnerController;

test('every usage read is announced, so the sidebar summary follows the Usage page at once', async () => {
  const providers = [{ runtime: 'codex', windows: [] }];
  const seen = await announced(() => readUsage(controller({ 'daemon.usage': { providers } }), true));
  assert.deepEqual(seen, [{ providers, disabled: false }]);
});

test('turning Check usage off empties the summary at once; turning it on waits for the next read', async () => {
  const off = await announced(() => setUsageSetting(controller({ 'host.usage.setting.set': { enabled: false, host: 'h' } }), false));
  assert.deepEqual(off, [{ providers: [], disabled: true }]);
  const on = await announced(() => setUsageSetting(controller({ 'host.usage.setting.set': { enabled: true, host: 'h' } }), true));
  assert.deepEqual(on, []);
});
