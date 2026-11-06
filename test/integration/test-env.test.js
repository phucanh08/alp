// The environment scripts/test-lib.mjs gives a test run (t-bf7f, t-bfbd): no caller session, and with
// privateHome no caller executables or home either.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CALLER_SESSION_VARIABLES, XDG_BASE_DIRECTORIES, clearCallerSession, hermeticEnv, homelessEnv, isCallerBinary } from '../../scripts/test-lib.mjs';

/** The POSIX base directories homelessEnv points at the private home, for a deepEqual on its output. */
const xdg = home => Object.fromEntries(Object.entries(XDG_BASE_DIRECTORIES).map(([name, relative]) => [name, path.join(home, relative)]));

test('isCallerBinary: ALP_<NAME>_BIN in any case, nothing else', () => {
  for (const name of ['ALP_CODEX_BIN', 'ALP_CLAUDE_BIN', 'ALP_ANTIGRAVITY_BIN', 'ALP_GH_BIN', 'alp_codex_bin', 'ALP_X2_BIN']) assert.equal(isCallerBinary(name), true, name);
  for (const name of ['ALP_BIN', 'ALP_HOME', 'ALP_BINARY', 'ALP_CODEX_BIN_DIR', 'MY_ALP_CODEX_BIN', 'PATH']) assert.equal(isCallerBinary(name), false, name);
});

test('homelessEnv: drops ALP_*_BIN and every spelling of private profile variables; keeps tools', () => {
  const caller = { PATH: 'p', ALP_HOME: 'h', ALP_CODEX_BIN: 'c', alp_gh_bin: 'g', HOME: '/home/me', UserProfile: 'C:\Users\me', home: 'x', ALP_TERMINAL: '1' };
  const env = homelessEnv(caller, '/tmp/u');
  assert.deepEqual(env, { PATH: 'p', ALP_HOME: 'h', ALP_TERMINAL: '1', HOME: '/tmp/u', USERPROFILE: '/tmp/u', APPDATA: path.join('/tmp/u', 'AppData', 'Roaming'), LOCALAPPDATA: path.join('/tmp/u', 'AppData', 'Local'), ...xdg('/tmp/u') });
  assert.equal(caller.ALP_CODEX_BIN, 'c', 'the caller env is not changed');
});

test('homelessEnv isolates Windows profile variables case-insensitively', () => {
  const caller = { PATH: 'tools', AppData: 'host-roaming', LOCALAPPDATA: 'host-local',
    HomeDrive: 'Z:', HOMEPATH: '\\Users\\host', appdata: 'other-host' };
  const env = homelessEnv(caller, 'C:\\private\\user');
  assert.equal(env.APPDATA, 'C:\\private\\user\\AppData\\Roaming');
  assert.equal(env.LOCALAPPDATA, 'C:\\private\\user\\AppData\\Local');
  assert.equal(env.HOMEDRIVE + env.HOMEPATH, 'C:\\private\\user');
  for (const name of ['AppData', 'HomeDrive', 'appdata']) assert.equal(env[name], undefined);
  assert.equal(env.PATH, 'tools');
  assert.equal(caller.AppData, 'host-roaming');
  const unc = homelessEnv(caller, '\\\\server\\share\\private');
  assert.equal(unc.HOMEDRIVE + unc.HOMEPATH, unc.USERPROFILE);
  assert.equal(unc.APPDATA, '\\\\server\\share\\private\\AppData\\Roaming');
});

test('hermeticEnv then homelessEnv: neither the caller session nor its executables reach the run', () => {
  const env = homelessEnv(hermeticEnv({ ALP_AGENT_SESSION: 's', ALP_BRIDGE_TOKEN: 't', ALP_CLAUDE_BIN: 'c', KEEP: 'k' }), 'u');
  assert.deepEqual(env, { KEEP: 'k', HOME: 'u', USERPROFILE: 'u', APPDATA: path.join('u', 'AppData', 'Roaming'), LOCALAPPDATA: path.join('u', 'AppData', 'Local'), ...xdg('u') });
});

test('normal runner isolates sessions and permits an unreferenced esbuild service', {timeout:15000}, async t => {
  const {mkdtemp,writeFile,access,rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const path = await import('node:path');
  const {execFile} = await import('node:child_process');
  const {promisify} = await import('node:util');
  const directory = await mkdtemp(path.join(tmpdir(),'alp-normal-file-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const file = path.join(directory,'normal.test.mjs');
  await writeFile(file, `import assert from 'node:assert/strict';
    import path from 'node:path';
    import {build} from ${JSON.stringify(new URL('../../node_modules/esbuild/lib/main.js',import.meta.url).href)};
    assert.equal(process.env.ALP_AGENT_SESSION,undefined);
    assert.equal(process.env.ALP_BRIDGE_TOKEN,undefined);
    const {existsSync} = await import('node:fs');
    for(const name of ['APPDATA','LOCALAPPDATA']) {
      assert.ok(existsSync(process.env[name]),name+' exists');
      assert.ok(path.relative(process.env.HOME,process.env[name]).startsWith('AppData'),name+' is private');
    }
    // t-d05e: the POSIX base directories a program reads instead of $HOME/.config are private too,
    // and they exist, so nothing falls back to the user's own.
    for(const name of ['XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME']) {
      assert.ok(existsSync(process.env[name]),name+' exists');
      const relative = path.relative(process.env.HOME,process.env[name]);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative),name+' is under the private home, got '+process.env[name]);
    }
    assert.equal(process.env.HOMESHARE,undefined);
    if(process.platform==='win32') assert.equal(process.env.HOMEDRIVE+process.env.HOMEPATH,process.env.USERPROFILE);
    await build({stdin:{contents:'export const value=1'},write:false});
    console.log('scratch='+JSON.stringify([process.env.ALP_HOME,process.env.TMPDIR,process.env.HOME]));`);
  const runner = new URL('../../scripts/test-lib.mjs',import.meta.url).href;
  const env = {...process.env,ALP_AGENT_SESSION:'injected-session',ALP_BRIDGE_TOKEN:'injected-token'};
  delete env.NODE_TEST_CONTEXT;
  const output = await promisify(execFile)(process.execPath,['--input-type=module','-e',
    `import {runNodeTests} from ${JSON.stringify(runner)};process.exitCode=runNodeTests([${JSON.stringify(file)}],{privateHome:true,fileTimeoutMs:5000});`],{env,timeout:10000});
  assert.ok(output.stderr.includes(`[test-file] START ${file}`));
  assert.ok(output.stderr.includes(`[test-file] PASS ${file}`));
  assert.ok(!output.stderr.includes('retained'),output.stderr);
  assert.ok(!output.stderr.includes('HANG DUMP'),'a file that ends in time dumps nothing');
  const scratch = JSON.parse(output.stdout.match(/scratch=(\[.+\])/)?.[1] || 'null');
  assert.equal(scratch.length,3);
  for(const dir of scratch) await assert.rejects(access(dir),{code:'ENOENT'});
});

test('hard timeout names the leaking file, returns boundedly, retains scratch and leaves a sentinel alone', {timeout:20000}, async t => {
  const {mkdtemp,writeFile,readFile,access,rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const path = await import('node:path');
  const {execFile,spawn} = await import('node:child_process');
  const {promisify} = await import('node:util');
  const directory = await mkdtemp(path.join(tmpdir(),'alp-file-timeout-'));
  const pidFile = path.join(directory,'detached-pid');
  let retained = [];
  t.after(async()=>{
    // The watchdog promises a deadline, not detached-tree containment. The
    // fixture has its own short fallback; wait for it before deleting scratch.
    try {
      const pid=Number(await readFile(pidFile,'utf8'));
      const until=Date.now()+10000;
      while(true) {
        try {process.kill(pid,0);} catch(error) {if(error.code==='ESRCH') break;throw error;}
        assert.ok(Date.now()<until,'fixture fallback must exit before cleanup');
        await new Promise(resolve=>setTimeout(resolve,30));
      }
    } catch(error) {if(error.code!=='ENOENT') throw error;}
    for(const dir of retained) await rm(dir,{recursive:true,force:true});
    await rm(directory,{recursive:true,force:true});
  });
  const sentinel=spawn(process.execPath,['-e','setTimeout(()=>{},20000)'],{stdio:'ignore'});
  t.after(()=>sentinel.kill('SIGKILL'));
  const file=path.join(directory,'leak.test.mjs');
  await writeFile(file, `import {spawn} from 'node:child_process';
    import {writeFileSync} from 'node:fs';
    const child=spawn(process.execPath,['-e','setTimeout(()=>{},8000)'],{detached:true,stdio:'inherit'});
    writeFileSync(${JSON.stringify(pidFile)},String(child.pid));child.unref();setInterval(()=>{},50);`);
  const runner=new URL('../../scripts/test-lib.mjs',import.meta.url).href;
  const env={...process.env};delete env.NODE_TEST_CONTEXT;
  const started=Date.now();
  const result=await promisify(execFile)(process.execPath,['--input-type=module','-e',
    `import {runNodeTests} from ${JSON.stringify(runner)};process.exitCode=runNodeTests([${JSON.stringify(file)}],{privateHome:true,fileTimeoutMs:1500});`],{env,timeout:8000}).catch(error=>error);
  assert.equal(result.code,1,result.stderr);
  assert.ok(Date.now()-started<7000,'hard watchdog must return before the detached fallback');
  assert.ok(result.stderr.includes(`[test-file] TIMEOUT ${file} after 1500 ms`),result.stderr);
  assert.ok(result.stderr.includes(`[test-file] FAIL ${file}`),result.stderr);
  assert.ok(result.stderr.includes('detached descendants may survive'),result.stderr);
  retained=result.stderr.match(/warning: cleanup unconfirmed; retained (.+)/)?.[1].split(', ') || [];
  assert.equal(retained.length,3,result.stderr);
  for(const dir of retained) await access(dir);
  assert.equal(sentinel.exitCode,null);
  process.kill(sentinel.pid,0);
});

// t-5294.2: three macOS files hung to the deadline after one subtest failed, and the spec reporter (which
// prints failures when a file ends) left nothing to diagnose. The fixture is that shape: a first after
// hook that throws skips the one closing a server, the next test passes, and the file never exits.
test('a file stopped at the deadline first dumps its subtests, failures, processes and open handles', {timeout:20000}, async t => {
  const {mkdtemp,writeFile,rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const path = await import('node:path');
  const {execFile} = await import('node:child_process');
  const {promisify} = await import('node:util');
  const directory = await mkdtemp(path.join(tmpdir(),'alp-hang-dump-'));
  let retained = [];
  t.after(async()=>{ for(const dir of retained) await rm(dir,{recursive:true,force:true}); await rm(directory,{recursive:true,force:true}); });
  const file = path.join(directory,'hung.test.mjs');
  await writeFile(file, `import test from 'node:test';
    import net from 'node:net';
    test('leaves a server open', async t => {
      const server = net.createServer();
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      t.after(() => { throw new Error('simulated ENOTEMPTY in the first hook'); });
      t.after(() => new Promise(resolve => server.close(resolve)));
    });
    test('a later test still passes', () => {});`);
  const runner = new URL('../../scripts/test-lib.mjs',import.meta.url).href;
  const env = {...process.env};delete env.NODE_TEST_CONTEXT;
  const result = await promisify(execFile)(process.execPath,['--input-type=module','-e',
    `import {runNodeTests} from ${JSON.stringify(runner)};process.exitCode=runNodeTests([${JSON.stringify(file)}],{privateHome:true,fileTimeoutMs:2000});`],{env,timeout:15000}).catch(error=>error);
  retained = result.stderr.match(/warning: cleanup unconfirmed; retained (.+)/)?.[1].split(', ') || [];
  assert.equal(result.code,1,result.stderr);
  const dump = result.stderr.slice(result.stderr.indexOf(`[test-file] HANG DUMP ${file}`));
  assert.ok(dump.includes(`[test-file] END HANG DUMP ${file}`),result.stderr);
  assert.ok(result.stderr.indexOf('[test-file] END HANG DUMP') < result.stderr.indexOf(`[test-file] FAIL ${file}`),'dumped before the file is stopped');
  assert.match(dump,/subtests: 1 passed, 1 failed, 0 in flight/);
  assert.match(dump,/not ok: leaves a server open \(\d+ ms, hookFailed\)\n\s+simulated ENOTEMPTY in the first hook/);
  assert.match(dump,/in flight: none; every subtest finished and the file's process stayed alive/);
  // Windows lists processes only on request (WMI can take seconds, more than the deadline's bound allows).
  if (process.platform === 'win32') {
    assert.match(dump,/ processes:\n  not collected on Windows \(ALP_WATCHDOG_WIN_PROCS=1/);
    assert.match(dump,/open handles: not available on Windows/);
  } else assert.match(dump,/ processes:\n  pid \d+/);
  // The file's own process names the server it never closed.
  if (process.platform !== 'win32') assert.match(dump,/hung\.test\.mjs\n(    .*\n)*?    tcp localEndpoint=\{[^}]*"port":\d+/);
  assert.ok(!/environmentVariables|"PATH"/.test(dump),'no environment in the dump');
});

test('abnormal coordinator exit retains all runner scratch', {timeout:15000}, async t => {
  const {mkdtemp,writeFile,access,rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const path = await import('node:path');
  const {execFile} = await import('node:child_process');
  const {promisify} = await import('node:util');
  const directory=await mkdtemp(path.join(tmpdir(),'alp-coordinator-exit-'));
  let retained=[];
  t.after(async()=>{
    for(const dir of retained) await rm(dir,{recursive:true,force:true});
    await rm(directory,{recursive:true,force:true});
  });
  const file=path.join(directory,'coordinator.test.mjs');
  await writeFile(file, '');
  // Target the coordinator itself, independently of which node:test process
  // executes --import on a given Node version. runNodeTests creates its scratch
  // marker before spawning this process, so an abrupt exit must retain it.
  const watchdog=new URL('../../scripts/test-file-watchdog.mjs',import.meta.url);
  const {fileURLToPath}=await import('node:url');
  const preload='data:text/javascript,'+encodeURIComponent(`if(process.argv[1]===${JSON.stringify(fileURLToPath(watchdog))}) process.kill(process.pid,'SIGKILL');`);
  const runner=new URL('../../scripts/test-lib.mjs',import.meta.url).href;
  const env={...process.env,NODE_OPTIONS:`--import=${preload}`};delete env.NODE_TEST_CONTEXT;
  const result=await promisify(execFile)(process.execPath,['--input-type=module','-e',
    `import {runNodeTests} from ${JSON.stringify(runner)};process.exitCode=runNodeTests([${JSON.stringify(file)}],{privateHome:true});`],{env,timeout:10000}).catch(error=>error);
  assert.equal(result.code,1,result.stderr);
  retained=result.stderr.match(/warning: cleanup unconfirmed; retained (.+)/)?.[1].split(', ') || [];
  assert.equal(retained.length,3,result.stderr);
  for(const dir of retained) await access(dir);
});

// t-5294.3 / t-3a63. An agent's shell exports ALP_AGENT_SESSION, every ALP client in a child process
// then announces `principal.agent`, and the user-only guards refuse it. That is correct for an agent
// doing the user's business — and wrong for a VERIFICATION run, which exists to check what the user's
// install does. Until this was fixed no agent could finish `npm run validate:core` (it exited 1 at
// scripts/core-standalone-smoke.mjs:138, where the installed CLI answered "alp web is the user's:
// ... this process was started by an ALP agent" instead of the expected "alp web is not built") or
// `npm run validate:packages` ("Only the user answers a question; this connection was opened by an
// ALP agent", in tarball-consumer.mjs's installed-plugin regressions). CI never saw it: a GitHub
// runner has no ALP and sets no session variable.
test('clearCallerSession removes exactly the caller session from the live env and reports what it removed', async t => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const saved = Object.fromEntries(CALLER_SESSION_VARIABLES.map(name => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  process.env.ALP_AGENT_SESSION = 'injected-session';
  process.env.ALP_BRIDGE_TOKEN = 'injected-token';
  process.env.ALP_KEEP_ME = 'kept';
  t.after(() => { delete process.env.ALP_KEEP_ME; });

  const removed = clearCallerSession();
  assert.ok(removed.includes('ALP_AGENT_SESSION') && removed.includes('ALP_BRIDGE_TOKEN'), removed.join(', '));
  assert.ok(!removed.includes('ALP_KEEP_ME'), 'only the session variables, so a caller can name them in a log line');
  for (const name of CALLER_SESSION_VARIABLES) assert.equal(process.env[name], undefined, name);
  assert.equal(process.env.ALP_KEEP_ME, 'kept');
  assert.deepEqual(clearCallerSession(), [], 'nothing left to remove, so nothing is claimed');

  // The point of doing it in place: a child spawned with no env of its own is clean too, which is
  // how scripts/validate.mjs isolates every step it runs.
  const child = await promisify(execFile)(process.execPath, ['-p', 'JSON.stringify([process.env.ALP_AGENT_SESSION, process.env.ALP_BRIDGE_TOKEN, process.env.ALP_KEEP_ME])'], { timeout: 20_000 });
  assert.deepEqual(JSON.parse(child.stdout), [null, null, 'kept']);
});

// The wiring, file by file, because the defect was never one guard: it was every entry point that
// drives a user-facing CLI while inheriting the caller's shell. The behaviour is covered above; this
// says each of those entry points is actually connected to it, including the ones that are run
// directly as well as through the validate wrapper.
test('every verification entry point that drives a user-facing CLI isolates the caller session', async () => {
  const { readFile } = await import('node:fs/promises');
  const entries = {
    // The wrapper: its steps spawn without an env of their own, so clearing here covers the lane.
    'scripts/validate.mjs': 'npm run validate:core / :paseo / :packages / :web',
    // Also run directly, so each clears for itself rather than trusting the wrapper.
    'scripts/core-standalone-smoke.mjs': 'npm run test:core:standalone',
    'scripts/tarball-consumer.mjs': 'npm run release:tarball-check',
    'scripts/package-smoke.mjs': 'npm run test:packages:smoke',
    'scripts/binary-smoke.mjs': 'the binary-build CI lane, and by hand on a built bundle',
  };
  for (const [relative, how] of Object.entries(entries)) {
    const source = await readFile(new URL(`../../${relative}`, import.meta.url), 'utf8');
    assert.match(source, /clearCallerSession\(\)/, `${relative} (${how}) must clear the caller's ALP session variables: an agent running it otherwise hits a user-only refusal that has nothing to do with what it checks`);
  }
});

// t-d05e (oracle review of da711fc): redirecting HOME, USERPROFILE, APPDATA, LOCALAPPDATA, HOMEDRIVE
// and HOMEPATH leaves two other ways to the user's real directories. HOMESHARE is the network home a
// Windows domain profile defines. The XDG base directories are read INSTEAD of $HOME/.config and
// friends when they are set, and this repository has a consumer that reads one:
// packages/client/src/service.js resolves the systemd user unit directory to
// `XDG_CONFIG_HOME/systemd/user`, so a private-home run that installed a service without
// ALP_SERVICE_DIR would have written a unit into the user's own ~/.config. (Every service test today
// sets ALP_SERVICE_DIR, so nothing depended on the real XDG directories; this closes the way in
// before something does.)
test('homelessEnv: HOMESHARE and the XDG base directories cannot reach past the private home', () => {
  const caller = { PATH: 'p', HOMESHARE: '\\\\fileserver\\home\\me', homeshare: '\\\\other\\home',
    XDG_CONFIG_HOME: '/Users/me/.config', XDG_DATA_HOME: '/Users/me/.local/share', XDG_CACHE_HOME: '/Users/me/.cache',
    XDG_RUNTIME_DIR: '/run/user/501', KEEP: 'k' };
  const env = homelessEnv(caller, '/tmp/private');
  for (const name of ['HOMESHARE', 'homeshare']) assert.equal(env[name], undefined, name);
  assert.equal(env.XDG_CONFIG_HOME, path.join('/tmp/private', '.config'));
  assert.equal(env.XDG_DATA_HOME, path.join('/tmp/private', '.local', 'share'));
  assert.equal(env.XDG_CACHE_HOME, path.join('/tmp/private', '.cache'));
  // systemd owns XDG_RUNTIME_DIR (0700, its sockets live there): replacing it would change
  // behaviour rather than isolate it, so it is left exactly as the caller had it.
  assert.equal(env.XDG_RUNTIME_DIR, '/run/user/501');
  assert.equal(env.KEEP, 'k');
  assert.equal(caller.HOMESHARE, '\\\\fileserver\\home\\me', 'the caller env is not changed');
  // An unset XDG variable still gets the private value: a child must never fall back to $HOME/.config
  // of a HOME that a later spread could restore, and the directory is one runNodeTests created.
  assert.equal(homelessEnv({ PATH: 'p' }, '/tmp/private').XDG_CONFIG_HOME, path.join('/tmp/private', '.config'));
});
