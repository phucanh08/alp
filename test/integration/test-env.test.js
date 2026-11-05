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
    import {build} from ${JSON.stringify(new URL('../../node_modules/esbuild/lib/main.js',import.meta.url).href)};
    assert.equal(process.env.ALP_AGENT_SESSION,undefined);
    assert.equal(process.env.ALP_BRIDGE_TOKEN,undefined);
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
