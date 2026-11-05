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
  const { mkdtemp, writeFile, readFile, rm, access } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { execFile, spawn } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const path = await import('node:path');
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-watchdog-'));
  // A bounded fallback in the detached fixture prevents a failing old watchdog
  // from leaving a long-lived process. Retain scratch until it has exited.
  t.after(async () => {
    for (const file of [detachedPidFile, grandchildPidFile]) {
      try { detachedPids.push(Number(await readFile(file, 'utf8'))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    for (const pid of new Set(detachedPids)) await waitGone(pid, 16_000);
    await rm(directory, { recursive: true, force: true });
  });
  const detachedPids = [];
  async function waitGone(pid, limit = 1000) {
    const until = Date.now() + limit;
    while (Date.now() < until) {
      try { process.kill(pid, 0); } catch (error) {
        assert.equal(error.code, 'ESRCH');
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(`leaked test process ${pid} is still alive`);
  }
  const pidFile = path.join(directory, 'pid');
  const detachedPidFile = path.join(directory, 'detached-pid');
  const grandchildPidFile = path.join(directory, 'grandchild-pid');
  const rootPidFile = path.join(directory, 'root-pid');
  const leak = path.join(directory, 'leak.test.mjs');
  const blocked = path.join(directory, 'blocked.test.mjs');
  const sentinel = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 25000)'], { stdio: 'ignore' });
  t.after(() => sentinel.kill('SIGKILL'));
  const grandchildCode = `const {spawn} = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 12000)'], {detached:true, stdio:'ignore'});
    require('node:fs').writeFileSync(${JSON.stringify(grandchildPidFile)}, String(child.pid));
    child.unref(); setTimeout(() => {}, 12000);`;
  const good = path.join(directory, 'good.test.mjs');
  const fixture = `import { writeFileSync } from 'node:fs';
    import { spawn } from 'node:child_process';
    const detached = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildCode)}], {
      detached: true, stdio: 'ignore'
    });
    writeFileSync(${JSON.stringify(detachedPidFile)}, String(detached.pid));
    detached.unref();
    writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    writeFileSync(${JSON.stringify(rootPidFile)}, String(process.ppid));
    setInterval(() => {}, 50);`;
  await writeFile(leak, fixture);
  await writeFile(blocked, fixture + '\nAtomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);');
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
  const detachedPid = Number(await readFile(detachedPidFile, 'utf8'));
  const grandchildPid = Number(await readFile(grandchildPidFile, 'utf8'));
  detachedPids.push(detachedPid, grandchildPid);
  await waitGone(pid);
  await waitGone(Number(await readFile(rootPidFile, 'utf8')));
  await waitGone(detachedPid);
  await waitGone(grandchildPid);
  assert.ok(!result.stderr.includes('CLEANUP-UNCONFIRMED'), result.stderr);
  const blockedStarted = Date.now();
  const blockedRun = await invoke([blocked]);
  assert.equal(blockedRun.code, 1, blockedRun.stderr);
  assert.ok(Date.now() - blockedStarted < 10000, 'unresponsive owner cleanup is bounded');
  assert.ok(blockedRun.stderr.includes('CLEANUP-UNCONFIRMED'), blockedRun.stderr);
  const retained = blockedRun.stderr.match(/warning: cleanup unconfirmed; retained (.+)/)?.[1].split(', ');
  assert.ok(retained?.length >= 2, blockedRun.stderr);
  for (const dir of retained) await access(dir);
  const blockedPids = await Promise.all([detachedPidFile, grandchildPidFile].map(async file => Number(await readFile(file, 'utf8'))));
  detachedPids.push(...blockedPids);
  assert.equal(sentinel.exitCode, null, 'unrelated sentinel survives cleanup');
  process.kill(sentinel.pid, 0);
  // Only remove this invocation's retained scratch after fallback exits are
  // confirmed. A failing wait leaves it for diagnosis.
  for (const pid of blockedPids) await waitGone(pid, 16000);
  for (const dir of retained) await rm(dir, {recursive:true, force:true});
});

for (const method of ['spawnSync', 'execFileSync']) {
  test(`watchdog keeps scratch when detached ${method} blocks its owner; completed sync passes`, {timeout: 25000}, async t => {
    const {mkdtemp, writeFile, readFile, access, rm} = await import('node:fs/promises');
    const {tmpdir} = await import('node:os');
    const {join} = await import('node:path');
    const {execFile} = await import('node:child_process');
    const {promisify} = await import('node:util');
    const dir = await mkdtemp(join(tmpdir(), 'alp-sync-watchdog-'));
    const pidFile = join(dir, 'pid');
    const good = join(dir, 'good.mjs');
    const blocked = join(dir, 'blocked.mjs');
    const runner = new URL('../../scripts/test-lib.mjs', import.meta.url).href;
    const env = {...process.env};
    delete env.NODE_TEST_CONTEXT;
    const invoke = async file => {
      try {
        return {...await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
          `import {runNodeTests} from ${JSON.stringify(runner)}; process.exitCode = runNodeTests([${JSON.stringify(file)}], {fileTimeoutMs:2000, privateHome:true});`], {env, timeout:10000}), code:0};
      } catch (error) { return error; }
    };
    // The detached child is responsive but its spawning owner is synchronously
    // blocked. Only the child's own bounded timer proves its eventual exit.
    const childCode = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 6500);`;
    await writeFile(good, `import {${method}} from 'node:child_process'; ${method}(process.execPath, ['-e', ''], {stdio:'ignore'});`);
    await writeFile(blocked, `import {${method}} from 'node:child_process'; ${method}(process.execPath, ['-e', ${JSON.stringify(childCode)}], {detached:true, stdio:'ignore'});`);
    let retained = [];
    t.after(async () => {
      let pid;
      try { pid = Number(await readFile(pidFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (pid) {
        const until = Date.now() + 10000;
        while (true) {
          try { process.kill(pid, 0); } catch (error) { assert.equal(error.code, 'ESRCH'); break; }
          assert.ok(Date.now() < until, 'sync fixture must exit before scratch removal');
          await new Promise(resolve => setTimeout(resolve, 25));
        }
      }
      for (const path of [...retained, dir]) await rm(path, {recursive:true, force:true});
    });
    const normal = await invoke(good);
    assert.equal(normal.code, 0, normal.stderr);
    const started = Date.now();
    const result = await invoke(blocked);
    retained = result.stderr.match(/warning: cleanup unconfirmed; retained (.+)/)?.[1].split(', ') || [];
    assert.equal(result.code, 1, result.stderr);
    assert.ok(Date.now() - started < 6000, 'cleanup is bounded while synchronous owner blocks');
    assert.ok(result.stderr.includes('CLEANUP-UNCONFIRMED'), result.stderr);
    process.kill(Number(await readFile(pidFile, 'utf8')), 0); // still live; retention is necessary
    assert.ok(retained.length >= 2, result.stderr);
    for (const path of retained) await access(path);
  });
}

test('duplicate control registration cannot replace an owner or clear cleanup uncertainty', {timeout:10000}, async t => {
  const {mkdtemp, writeFile, access, rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  const {execFile} = await import('node:child_process');
  const {promisify} = await import('node:util');
  const dir = await mkdtemp(join(tmpdir(), 'alp-duplicate-watchdog-'));
  const file = join(dir, 'duplicate.mjs');
  let retained = [];
  t.after(async () => {
    for (const path of [...retained, dir]) await rm(path, {recursive:true, force:true});
  });
  await writeFile(file, `import {createConnection} from 'node:net';
    const socket = createConnection(process.env.ALP_TEST_CONTROL);
    socket.on('error', () => {});
    socket.on('connect', () => socket.end(JSON.stringify({type:'hello', id:process.env.ALP_TEST_PROCESS, token:process.env.ALP_TEST_SECRET})+'\\n'+JSON.stringify({type:'ack'})+'\\n'));
    setTimeout(() => {}, 100);`);
  const env = {...process.env}; delete env.NODE_TEST_CONTEXT;
  const runner = new URL('../../scripts/test-lib.mjs', import.meta.url).href;
  let result;
  try {
    result = {...await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
      `import {runNodeTests} from ${JSON.stringify(runner)}; process.exitCode = runNodeTests([${JSON.stringify(file)}], {fileTimeoutMs:2000, privateHome:true});`], {env, timeout:7000}), code:0};
  } catch (error) { result = error; }
  retained = result.stderr.match(/warning: cleanup unconfirmed; retained (.+)/)?.[1].split(', ') || [];
  assert.equal(result.code, 1, result.stderr);
  assert.ok(result.stderr.includes('CLEANUP-UNCONFIRMED'), result.stderr);
  assert.ok(retained.length >= 2, result.stderr);
  for (const path of retained) await access(path);
});
