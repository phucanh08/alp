import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('built alp --version prints the package version without creating runtime state', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-version-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [cli, '--version'], {
    cwd: directory,
    env: { ...process.env, ALP_HOME: path.join(directory, 'home') },
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${manifest.version}\n`);
  assert.equal(result.stderr, '');
  assert.deepEqual(await readdir(directory), [], 'version must not create ALP_HOME or runtime files');
});
