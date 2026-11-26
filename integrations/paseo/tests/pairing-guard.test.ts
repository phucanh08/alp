import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPairingCaller, isUserOnlyRefusal } from '../server/dist/pairing-guard.js';

test('web.pairing: a user caller passes', () => {
  assert.doesNotThrow(() => assertPairingCaller({ caller: { agent: false } }));
});

test('web.pairing: an agent caller is refused as user-only', () => {
  assert.throws(() => assertPairingCaller({ caller: { agent: true, agentName: 'peer' } }),
    error => error.code === 1003 && error.data.reason === 'user_only' && /opened by an ALP agent/.test(error.message));
});

test('web.pairing: a missing caller is refused as user-only with a restart hint (t-d08b)', () => {
  for (const params of [{}, undefined, { caller: null }, { caller: {} }]) {
    assert.throws(() => assertPairingCaller(params),
      error => error.code === 1003 && error.data.reason === 'user_only' && /did not say who is calling.*restart alpd/.test(error.message));
  }
});

test('extension.register refusal: only user_only is terminal', () => {
  assert.equal(isUserOnlyRefusal({ code: 1003, data: { reason: 'user_only' } }), true);
  assert.equal(isUserOnlyRefusal({ code: -32000, message: 'socket closed' }), false);
  assert.equal(isUserOnlyRefusal(undefined), false);
});
