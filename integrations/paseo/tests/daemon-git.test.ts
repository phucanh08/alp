import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

test('Windows checkout polling hides every Git child console and preserves checkout facts', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'alp-git-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = path.join(directory, 'git.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('../server/paseo/git.ts', import.meta.url))], outfile, bundle: true, platform: 'node', format: 'esm' });
  // A separate process keeps the child_process boundary mock out of other daemon tests.
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    Object.defineProperty(process, 'platform', {value:'win32'});
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { promisify } from 'node:util';
    const calls = [];
    const execFile = () => {};
    execFile[promisify.custom] = async (command, args, options) => {
      calls.push({ command, args, options });
      const stdout = args.includes('--show-toplevel') ? '/repo\\n'
        : args.includes('--abbrev-ref') ? 'main\\n'
        : args.includes('--get') ? 'https://example.com/repo.git\\n' : ' M file.txt\\n';
      return { stdout, stderr: '' };
    };
    childProcess.execFile = execFile;
    syncBuiltinESMExports();
    const { checkoutCache, checkoutFacts } = await import(${JSON.stringify(pathToFileURL(outfile).href)});
    // The bridge's own read, as the fallback for a daemon without workspace.git.facts (-32601).
    const cache = checkoutCache(10_000, checkoutFacts);
    const facts = await cache.read('/repo');
    assert.deepEqual(facts, { isGit: true, repoRoot: '/repo', currentBranch: 'main', remoteUrl: 'https://example.com/repo.git', isDirty: true });
    await cache.read('/repo');
    assert.equal(calls.length, 4, 'cached facts do not start more Git processes');
    await cache.read('/repo', true);
    assert.equal(calls.length, 8, 'the next poll refreshes checkout facts');
    for (const call of calls) {
      assert.equal(call.command, 'git');
      assert.deepEqual(call.args.slice(0, 2), ['-C', '/repo']);
      assert.equal(call.options.windowsHide, true, 'Git polling must hide Windows consoles');
      assert.equal(call.options.env.GIT_OPTIONAL_LOCKS, '0');
    }
  `], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
});

test('POSIX checkout cache preserves facts and caching without executing repository fsmonitor',async t=>{
 if(process.platform==='win32')return t.skip('POSIX hardened read adapter');
 const assert=(await import('node:assert/strict')).default;const {mkdir,writeFile,realpath,access}=await import('node:fs/promises');
 const directory=await realpath(await mkdtemp(path.join(os.tmpdir(),'alp-safe-checkout-')));t.after(()=>rm(directory,{recursive:true,force:true}));const repo=path.join(directory,'repo');await mkdir(repo);
 const native=(...args)=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{cwd:repo,env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},encoding:'utf8'}).trim();
 native('init','-qb','main');await writeFile(path.join(repo,'file'),'one');native('add','.');native('-c','user.name=Test','-c','user.email=test@localhost','commit','-qm','initial');native('config','remote.origin.url','https://example.com/repo.git');const trap=path.join(directory,'TRAP');native('config','core.fsmonitor',`touch '${trap}'`);
 const outfile=path.join(directory,'git.mjs');await build({entryPoints:[fileURLToPath(new URL('../server/paseo/git.ts',import.meta.url))],outfile,bundle:true,platform:'node',format:'esm'});const {checkoutCache,checkoutFacts}=await import(pathToFileURL(outfile).href);const cache=checkoutCache(10_000,checkoutFacts);
 assert.deepEqual(await cache.read(repo),{isGit:true,repoRoot:repo,currentBranch:'main',remoteUrl:'https://example.com/repo.git',isDirty:false});await writeFile(path.join(repo,'file'),'two');assert.equal((await cache.read(repo)).isDirty,false);assert.equal((await cache.read(repo,true)).isDirty,true);await assert.rejects(access(trap));
});
