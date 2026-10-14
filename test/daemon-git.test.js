import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

test('checkout polling hides every Git child console and preserves checkout facts', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'alp-git-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = path.join(directory, 'git.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('../packages/daemon/src/paseo/git.ts', import.meta.url))], outfile, bundle: true, platform: 'node', format: 'esm' });
  // A separate process keeps the child_process boundary mock out of other daemon tests.
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
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
    const { checkoutCache } = await import(${JSON.stringify(pathToFileURL(outfile).href)});
    const cache = checkoutCache();
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
