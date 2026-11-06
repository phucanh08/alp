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
  // The opt-in is SET here, never inherited (t-5294.7): the Windows listing runs only with
  // ALP_WATCHDOG_WIN_PROCS=1, so a suite run that happened to have it set used to flip this test's
  // own expectation and fail it for a reason unrelated to the code under test. On Windows the
  // variable makes the windows-daemon lane the one place the WMI listing really executes; on POSIX
  // it means nothing, and is dropped so the run stays the cheap one.
  if (process.platform === 'win32') env.ALP_WATCHDOG_WIN_PROCS = '1'; else delete env.ALP_WATCHDOG_WIN_PROCS;
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
  // Windows lists processes only on request (WMI can take seconds, more than the deadline's bound
  // allows), and this run asked for it above: the file's own process must be in the listing either
  // way. The refusal when nobody asks is covered without a Windows host by the
  // scripts/test-file-watchdog-processes.mjs tests below.
  // On Windows this is the one place the WMI query and its process-tree walk really run; the rows it
  // parsed have the module's Windows shape (no pgid/stat/etime, which only `ps` reports).
  assert.match(dump,process.platform === 'win32' ? / processes:\n  pid \d+ ppid \d+: / : / processes:\n  pid \d+ ppid \d+ pgid \d+ /);
  if (process.platform === 'win32') assert.match(dump,/open handles: not available on Windows/);
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
  const ts = (await import('typescript')).default;
  const entries = {
    // The wrapper: its steps spawn without an env of their own, so clearing here covers the lane.
    'scripts/validate.mjs': 'npm run validate:core / :paseo / :packages / :web',
    // Also run directly, so each clears for itself rather than trusting the wrapper.
    'scripts/core-standalone-smoke.mjs': 'npm run test:core:standalone',
    'scripts/tarball-consumer.mjs': 'npm run release:tarball-check',
    'scripts/package-smoke.mjs': 'npm run test:packages:smoke',
    'scripts/binary-smoke.mjs': 'the binary-build CI lane, and by hand on a built bundle',
  };
  /**
   * Does this subtree start a child process? Only that: `await mkdtemp(...)` is not work whose
   * environment matters, and demanding the clear come before it would be a rule about tidiness
   * rather than about the defect. The limit of the check is an imported module that spawns while
   * being imported, which none of these five does.
   */
  const startsWork = node => {
    let found = false;
    const walk = child => {
      if (found) return;
      if (ts.isCallExpression(child)) {
        const callee = child.expression;
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
        if (/^(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork|run|npm|node)$/.test(name)) found = true;
      }
      ts.forEachChild(child, walk);
    };
    walk(node);
    return found;
  };
  for (const [relative, how] of Object.entries(entries)) {
    const source = await readFile(new URL(`../../${relative}`, import.meta.url), 'utf8');
    const parsed = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    // Top-level statements in order. A function or class DECLARATION only defines something, so a
    // `spawnSync` inside one is not work this file has done yet — which is why reading offsets out
    // of the text is not enough: scripts/package-smoke.mjs declares its `run()` wrapper above the
    // isolation and calls it below.
    const statements = parsed.statements.filter(statement =>
      !ts.isImportDeclaration(statement) && !ts.isFunctionDeclaration(statement) && !ts.isClassDeclaration(statement));
    const cleared = statements.findIndex(statement => /\bclearCallerSession\s*\(/.test(statement.getText()));
    assert.ok(cleared >= 0, `${relative} (${how}) must clear the caller's ALP session variables at the top level: an agent running it otherwise hits a user-only refusal that has nothing to do with what it checks`);
    // And it must come first. The point is the CHILD's environment, so a clear after the first child
    // has started changes nothing for that child: validate.mjs printed its banner — two `git` calls —
    // before clearing, until this assertion said so.
    const work = statements.findIndex(startsWork);
    assert.ok(work < 0 || cleared < work,
      `${relative} (${how}) clears the caller session in top-level statement ${cleared}, after statement ${work} already started a child process:\n  ${statements[work].getText().split('\n')[0]}`);
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

// t-5294.7 (2): nothing ever ran the Windows opt-in process listing, so its WMI parsing and tree
// walk were only ever read, never executed. scripts/test-file-watchdog.mjs is an executable script
// (it reads process.argv[2] and finishes with a top-level await), so a test cannot import it; the
// listing lives in its own module for exactly this reason, with platform, env and capture injected.
test('the watchdog lists no Windows processes unless ALP_WATCHDOG_WIN_PROCS=1 asks for them (t-5294.7)', async () => {
  const { processSummary } = await import('../../scripts/test-file-watchdog-processes.mjs');
  let called = 0;
  const capture = () => { called++; return Promise.resolve({ stdout: '' }); };
  const lines = await processSummary(1234, { platform: 'win32', env: {}, capture });
  assert.equal(called, 0, 'no WMI query without the opt-in');
  assert.deepEqual(lines, ['  not collected on Windows (ALP_WATCHDOG_WIN_PROCS=1 lists them through WMI, up to 2.5 s more)']);
  // Any other value is not the opt-in either.
  assert.deepEqual(await processSummary(1234, { platform: 'win32', env: { ALP_WATCHDOG_WIN_PROCS: 'true' }, capture }), lines);
  assert.equal(called, 0);
});

test('the watchdog opt-in lists the file\'s own Windows process tree and nothing else (t-5294.7)', async () => {
  const { processSummary } = await import('../../scripts/test-file-watchdog-processes.mjs');
  // What `Get-CimInstance Win32_Process` prints through the script's format string: pid, ppid,
  // command line, tab separated, CRLF ended. 1234 is the file's process; 5678 and 9012 descend from
  // it (a grandchild); 4 and 777 are unrelated and must not appear. 31 has no parent row at all.
  const rows = [
    '4\t0\tSystem',
    '1234\t999\tC:\\node.exe --test C:\\repo\\hung.test.mjs',
    '777\t999\tC:\\node.exe some other test file',
    '9012\t5678\tC:\\WINDOWS\\system32\\cmd.exe /c alp.cmd',
    '5678\t1234\tC:\\node.exe -e setTimeout(()=>{},8000)',
    '31\t4242\tghost.exe',
  ];
  const seen = [];
  const capture = (command, args, ms) => { seen.push({ command, args, ms }); return Promise.resolve({ stdout: rows.join('\r\n') + '\r\n' }); };
  const lines = await processSummary(1234, { platform: 'win32', env: { ALP_WATCHDOG_WIN_PROCS: '1' }, capture });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].command, 'powershell.exe');
  assert.deepEqual(seen[0].args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.match(seen[0].args[3], /^Get-CimInstance Win32_Process \|/, seen[0].args[3]);
  assert.ok(seen[0].ms <= 2500, `the query stays inside the deadline's bound: ${seen[0].ms} ms`);
  // The root first, then its descendants in the order the listing gave them.
  assert.deepEqual(lines, [
    '  pid 1234 ppid 999: C:\\node.exe --test C:\\repo\\hung.test.mjs',
    '  pid 9012 ppid 5678: C:\\WINDOWS\\system32\\cmd.exe /c alp.cmd',
    '  pid 5678 ppid 1234: C:\\node.exe -e setTimeout(()=>{},8000)',
  ]);
  // A listing that never arrives is reported, not thrown: the dump must stay bounded.
  assert.deepEqual(await processSummary(1234, { platform: 'win32', env: { ALP_WATCHDOG_WIN_PROCS: '1' },
    capture: () => Promise.resolve({ error: 'no answer within 2500 ms' }) }),
    ['  process list unavailable: no answer within 2500 ms']);
});

test('the watchdog process capture returns stdout, a bad status and a timeout, and outlives neither (t-5294.7)', async () => {
  const { capture } = await import('../../scripts/test-file-watchdog-processes.mjs');
  assert.deepEqual(await capture(process.execPath, ['-e', 'process.stdout.write("a\tb\tc")'], 5000), { stdout: 'a\tb\tc' });
  assert.deepEqual(await capture(process.execPath, ['-e', 'process.exit(3)'], 5000), { error: 'status 3' });
  const absent = await capture(path.join(import.meta.dirname, 'no-such-listing-command'), [], 5000);
  assert.match(absent.error, /ENOENT/, JSON.stringify(absent));
  assert.equal(absent.stdout, undefined);
  const started = Date.now();
  assert.deepEqual(await capture(process.execPath, ['-e', 'setInterval(()=>{},50)'], 300), { error: 'no answer within 300 ms' });
  assert.ok(Date.now() - started < 3000, `a hung listing is abandoned at its bound: ${Date.now() - started} ms`);
});
