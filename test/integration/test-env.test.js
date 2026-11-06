// The environment scripts/test-lib.mjs gives a test run (t-bf7f, t-bfbd): no caller session, and with
// privateHome no caller executables or home either.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { hermeticEnv, homelessEnv, isCallerBinary } from '../../scripts/test-lib.mjs';

test('isCallerBinary: ALP_<NAME>_BIN in any case, nothing else', () => {
  for (const name of ['ALP_CODEX_BIN', 'ALP_CLAUDE_BIN', 'ALP_ANTIGRAVITY_BIN', 'ALP_GH_BIN', 'alp_codex_bin', 'ALP_X2_BIN']) assert.equal(isCallerBinary(name), true, name);
  for (const name of ['ALP_BIN', 'ALP_HOME', 'ALP_BINARY', 'ALP_CODEX_BIN_DIR', 'MY_ALP_CODEX_BIN', 'PATH']) assert.equal(isCallerBinary(name), false, name);
});

test('homelessEnv: drops ALP_*_BIN and every spelling of private profile variables; keeps tools', () => {
  const caller = { PATH: 'p', ALP_HOME: 'h', ALP_CODEX_BIN: 'c', alp_gh_bin: 'g', HOME: '/home/me', UserProfile: 'C:\Users\me', home: 'x', ALP_TERMINAL: '1' };
  const env = homelessEnv(caller, '/tmp/u');
  assert.deepEqual(env, { PATH: 'p', ALP_HOME: 'h', ALP_TERMINAL: '1', HOME: '/tmp/u', USERPROFILE: '/tmp/u', APPDATA: path.join('/tmp/u', 'AppData', 'Roaming'), LOCALAPPDATA: path.join('/tmp/u', 'AppData', 'Local') });
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
  assert.deepEqual(env, { KEEP: 'k', HOME: 'u', USERPROFILE: 'u', APPDATA: path.join('u', 'AppData', 'Roaming'), LOCALAPPDATA: path.join('u', 'AppData', 'Local') });
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
  // Windows lists processes through WMI, which can answer too late for the 2.5 s it gets (best effort there).
  if (process.platform === 'win32') {
    assert.match(dump,/ processes:\n  (pid \d+|process list unavailable: no answer within 2500 ms)/);
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
