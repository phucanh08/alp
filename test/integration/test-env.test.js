// The environment scripts/test-lib.mjs gives a test run (t-bf7f, t-bfbd): no caller session, and with
// privateHome no caller executables or home either.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hermeticEnv, homelessEnv, isCallerBinary } from '../../scripts/test-lib.mjs';

test('isCallerBinary: ALP_<NAME>_BIN in any case, nothing else', () => {
  for (const name of ['ALP_CODEX_BIN', 'ALP_CLAUDE_BIN', 'ALP_ANTIGRAVITY_BIN', 'ALP_GH_BIN', 'alp_codex_bin', 'ALP_X2_BIN']) assert.equal(isCallerBinary(name), true, name);
  for (const name of ['ALP_BIN', 'ALP_HOME', 'ALP_BINARY', 'ALP_CODEX_BIN_DIR', 'MY_ALP_CODEX_BIN', 'PATH']) assert.equal(isCallerBinary(name), false, name);
});

test('homelessEnv: drops ALP_*_BIN and every spelling of HOME/USERPROFILE; keeps the rest', () => {
  const caller = { PATH: 'p', ALP_HOME: 'h', ALP_CODEX_BIN: 'c', alp_gh_bin: 'g', HOME: '/home/me', UserProfile: 'C:\Users\me', home: 'x', ALP_TERMINAL: '1' };
  const env = homelessEnv(caller, '/tmp/u');
  assert.deepEqual(env, { PATH: 'p', ALP_HOME: 'h', ALP_TERMINAL: '1', HOME: '/tmp/u', USERPROFILE: '/tmp/u' });
  assert.equal(caller.ALP_CODEX_BIN, 'c', 'the caller env is not changed');
});

test('hermeticEnv then homelessEnv: neither the caller session nor its executables reach the run', () => {
  const env = homelessEnv(hermeticEnv({ ALP_AGENT_SESSION: 's', ALP_BRIDGE_TOKEN: 't', ALP_CLAUDE_BIN: 'c', KEEP: 'k' }), 'u');
  assert.deepEqual(env, { KEEP: 'k', HOME: 'u', USERPROFILE: 'u' });
});
