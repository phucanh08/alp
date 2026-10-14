import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { validateBuildManifest } from '../../scripts/build-manifest.mjs';

const root = path.resolve(import.meta.dirname, '..', '..');

test('workspace source dependencies are declared, acyclic and stay inside their packages', () => {
  const result = spawnSync(process.execPath, ['scripts/check-boundaries.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('the neutral core build manifest proves no Paseo input or SDK reached a core bundle', async () => {
  const built = JSON.parse(await readFile(path.join(root, 'dist/build-manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(built.entries).sort(), ['dist/acp.js', 'dist/acp/agent.js', 'dist/alpd.js', 'dist/daemon/index.js', 'dist/runtime/index.js']);
  assert.deepEqual(validateBuildManifest(built), []);
  // A regression that reached the plugin or its SDK must be rejected, in inputs and in externals.
  const tampered = {
    version: built.version,
    entries: {
      'dist/daemon/index.js': { inputs: ['integrations/paseo/server/index.ts'], external: [] },
      'dist/runtime/index.js': { inputs: [], external: ['@getpaseo/plugin'] },
    },
  };
  assert.deepEqual(validateBuildManifest(tampered), [
    'dist/daemon/index.js: core bundle input integrations/paseo/server/index.ts',
    'dist/runtime/index.js: core bundle imports @getpaseo/plugin',
  ]);
});

test('the boundary checker rejects Paseo deps, imports, createRequire aliases and package escapes in a fixture', async t => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'alp-boundaries-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const write = async (relative, contents) => { await mkdir(path.dirname(path.join(fixture, relative)), { recursive: true }); await writeFile(path.join(fixture, relative), contents); };
  await write('package.json', JSON.stringify({ private: true, workspaces: ['packages/core', 'packages/daemon', 'apps/tui'] }));
  await write('apps/tui/package.json', JSON.stringify({ name: '@anhlp/alp-tui', version: '0.0.0', dependencies: {} }));
  await write('packages/core/package.json', JSON.stringify({ name: '@anhlp/alp-core', version: '0.0.0', dependencies: { '@getpaseo/plugin': '*' } }));
  await write('packages/core/src/index.ts', "import value from '@getpaseo/plugin';\nexport default value;\n");
  await write('packages/daemon/package.json', JSON.stringify({ name: '@anhlp/alp-daemon', version: '0.0.0', dependencies: { '@anhlp/alp-tui': '*' } }));
  await write('packages/daemon/src/index.ts', "import { createRequire } from 'node:module';\nconst req = createRequire(import.meta.url);\nconst plugin = req('@getpaseo/plugin');\nexport default plugin;\n");
  await write('packages/daemon/src/escape.ts', "import '../../outside.js';\nexport {};\n");

  const result = spawnSync(process.execPath, ['scripts/check-boundaries.mjs', '--root', fixture], { cwd: root, encoding: 'utf8' });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1, output);
  assert.match(output, /@anhlp\/alp-core: forbidden Paseo dependency @getpaseo\/plugin/);
  assert.match(output, /packages\/core\/src\/index\.ts: forbidden @getpaseo dependency in core package/);
  // The createRequire alias must be followed, not just the bare require in the fixture's daemon.
  assert.match(output, /packages\/daemon\/src\/index\.ts: forbidden @getpaseo dependency in core package: @getpaseo\/plugin/);
  assert.match(output, /@anhlp\/alp-daemon: depends on @anhlp\/alp-tui, which lives in apps\/tui/);
  assert.match(output, /packages\/daemon\/src\/escape\.ts: relative import escapes package: \.\.\/\.\.\/outside\.js/);
});
