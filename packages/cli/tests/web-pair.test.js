import test from 'node:test';
import assert from 'node:assert/strict';
import { requestPairing } from '../src/interfaces.js';

/**
 * `alp web pair` runs right after `alp daemon restart`, where the integration is still
 * re-registering `web.pairing` on the new daemon connection. The old code called the method once
 * and failed with -32601 in that window; the fix waits for the fresh registration. These tests
 * drive the wait directly, without a daemon, so the race is deterministic.
 */

/** A client whose `web.pairing` reply is "unknown method" for `pending` calls, then succeeds. */
function lateRegistrationClient(pending, value) {
  let calls = 0;
  return {
    calls: () => calls,
    request: async (method, params) => {
      assert.equal(method, 'web.pairing');
      calls += 1;
      if (calls <= pending) throw Object.assign(new Error(`unknown method: ${method}`), { code: -32601 });
      return { ...value, seen: params };
    },
  };
}

test('pair waits for the delayed web.pairing registration instead of failing with -32601', async () => {
  const params = { enable: true };
  const client = lateRegistrationClient(4, { relayEnabled: true, endpoint: 'wss://relay.test', connected: true, url: 'https://relay.test/pair?x=1' });
  const pairing = await requestPairing(client, params);
  assert.equal(client.calls(), 5, 'four unknown-method replies were retried, the fifth succeeded');
  assert.equal(pairing.relayEnabled, true);
  assert.deepEqual(pairing.seen, params, 'the original params are re-sent on every attempt');
});

test('pair reports the registration still missing once the attempts run out', async () => {
  const client = lateRegistrationClient(Number.POSITIVE_INFINITY, {});
  await assert.rejects(() => requestPairing(client, {}, 3), /unknown method/);
  assert.equal(client.calls(), 3, 'it stops after the given attempts rather than waiting forever');
});

test('pair surfaces a non-transient error immediately', async () => {
  let calls = 0;
  const client = {
    request: async () => {
      calls += 1;
      throw Object.assign(new Error('relay refused the connection'), { code: 1000 });
    },
  };
  await assert.rejects(() => requestPairing(client, {}, 5), /relay refused the connection/);
  assert.equal(calls, 1, 'a real failure is not retried');
});
