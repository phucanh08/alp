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

test('runNodeTests removes caller sessions and kills leaked file processes with named progress (t-50af)', { timeout: 30_000 }, async t => {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const path = await import('node:path');
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-watchdog-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pidFile = path.join(directory, 'pid');
  const leak = path.join(directory, 'leak.test.mjs');
  const good = path.join(directory, 'good.test.mjs');
  await writeFile(leak, `import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    setInterval(() => {}, 50);`);
  await writeFile(good, `import assert from 'node:assert/strict';
    assert.equal(process.env.ALP_AGENT_SESSION, undefined);
    assert.equal(process.env.ALP_BRIDGE_TOKEN, undefined);`);
  const runner = new URL('../../scripts/test-lib.mjs', import.meta.url).href;
  const env = { ...process.env, ALP_AGENT_SESSION: 'injected-session', ALP_BRIDGE_TOKEN: 'injected-token' };
  delete env.NODE_TEST_CONTEXT; // this deliberately starts a new runner, not a nested node:test context
  const invoke = async files => {
    try {
      const output = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
        `import {runNodeTests} from ${JSON.stringify(runner)};
         process.exitCode = runNodeTests(${JSON.stringify(files)}, {fileTimeoutMs: 4000, privateHome: true});`],
      { env, timeout: 15_000 });
      return { ...output, code: 0 };
    } catch (error) { return error; }
  };
  const goodRun = await invoke([good]);
  assert.equal(goodRun.code, 0, goodRun.stderr);
  assert.ok(goodRun.stderr.includes(`[test-file] START ${good}`));
  assert.ok(goodRun.stderr.includes(`[test-file] PASS ${good}`));
  const result = await invoke([leak]);
  assert.equal(result.code, 1, result.stderr);
  assert.ok(result.stderr.includes(`[test-file] TIMEOUT ${leak}`), result.stderr);
  assert.ok(result.stderr.includes(`[test-file] FAIL ${leak}`), result.stderr);
  const pid = Number(await readFile(pidFile, 'utf8'));
  // The --test child as well as its parent must have been killed. On POSIX the
  // orphan may briefly be a zombie, so allow the OS reaper a short turn.
  for (let attempt = 0; attempt < 50; attempt++) {
    try { process.kill(pid, 0); } catch (error) { assert.equal(error.code, 'ESRCH'); return; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`leaked test process ${pid} is still alive`);
});
