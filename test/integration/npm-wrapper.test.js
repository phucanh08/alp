// The npm wrapper @anhlp/alp (npm/alp, t-1807): it depends on @anhlp/alp-cli at the same version
// and its `alp` runs that CLI on the user's Node, with the arguments, stdio and exit code unchanged.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LAUNCHER, launcherProblems } from '../../scripts/release-lib.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const WRAPPER = path.join(ROOT, 'npm/alp');
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));

test('the wrapper depends on exactly @anhlp/alp-cli at its own version, with no platform packages or install scripts', async () => {
  const pkg = await readJson(path.join(WRAPPER, 'package.json'));
  const root = await readJson(path.join(ROOT, 'package.json'));
  assert.equal(pkg.name, LAUNCHER);
  assert.equal(pkg.version, root.version);
  assert.deepEqual(pkg.dependencies, { '@anhlp/alp-cli': pkg.version });
  assert.equal(pkg.optionalDependencies, undefined);
  assert.deepEqual(pkg.engines, { node: '>=22.12' });
  assert.deepEqual(pkg.bin, { alp: 'bin/alp.js' });
  assert.deepEqual(pkg.files, ['bin/alp.js', 'README.md', 'LICENSE', 'NOTICE']);
  assert.deepEqual(launcherProblems(pkg, pkg.version), []);
  const cli = await readJson(path.join(ROOT, 'packages/cli/package.json'));
  assert.equal(cli.version, pkg.version);
  assert.ok(cli.exports['./cli'], '@anhlp/alp-cli exports ./cli, which bin/alp.js imports');
});

test('launcherProblems refuses another dependency, a range, platform packages and install scripts', () => {
  const good = { bin: { alp: 'bin/alp.js' }, dependencies: { '@anhlp/alp-cli': '1.0.0' } };
  assert.deepEqual(launcherProblems(good, '1.0.0'), []);
  assert.match(launcherProblems({ ...good, dependencies: { '@anhlp/alp-cli': '^1.0.0' } }, '1.0.0').join('\n'), /exactly @anhlp\/alp-cli@1\.0\.0/);
  assert.match(launcherProblems({ ...good, dependencies: {} }, '1.0.0').join('\n'), /exactly @anhlp\/alp-cli@1\.0\.0/);
  assert.match(launcherProblems({ ...good, dependencies: { ...good.dependencies, 'left-pad': '1.0.0' } }, '1.0.0').join('\n'), /exactly/);
  assert.match(launcherProblems({ ...good, optionalDependencies: { '@anhlp/alp-darwin-arm64': '1.0.0' } }, '1.0.0').join('\n'), /no optionalDependencies/);
  assert.match(launcherProblems({ ...good, scripts: { postinstall: 'node x' } }, '1.0.0').join('\n'), /no postinstall/);
  assert.match(launcherProblems({ ...good, bin: { alp: 'lib/x.js' } }, '1.0.0').join('\n'), /bin must be/);
});

test('the installed wrapper runs @anhlp/alp-cli\'s cli with the arguments, stdio and exit code', { timeout: 30_000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'alp-npm-wrapper-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const wrapper = path.join(dir, 'node_modules/@anhlp/alp');
  const cli = path.join(dir, 'node_modules/@anhlp/alp-cli');
  await mkdir(path.join(wrapper, 'bin'), { recursive: true });
  await mkdir(path.join(cli, 'dist'), { recursive: true });
  await copyFile(path.join(WRAPPER, 'package.json'), path.join(wrapper, 'package.json'));
  await copyFile(path.join(WRAPPER, 'bin/alp.js'), path.join(wrapper, 'bin/alp.js'));
  // A stand-in for @anhlp/alp-cli: the same export condition the published package resolves.
  await writeFile(path.join(cli, 'package.json'), JSON.stringify({ name: '@anhlp/alp-cli', version: '0.0.0', type: 'module', exports: { './cli': { default: './dist/cli.js' } } }));
  await writeFile(path.join(cli, 'dist/cli.js'), `let input = ''; for await (const chunk of process.stdin) input += chunk;
process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input })); process.stderr.write('to stderr'); process.exitCode = 7;\n`);
  const result = spawnSync(process.execPath, [path.join(wrapper, 'bin/alp.js'), 'init', 'two words', '--flag'], { input: 'from stdin', encoding: 'utf8' });
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { args: ['init', 'two words', '--flag'], input: 'from stdin' });
  assert.equal(result.stderr, 'to stderr');
});
