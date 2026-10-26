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
  const output = (result.stdout + result.stderr).replaceAll('\\', '/'); // the checker prints file paths with the OS separator
  assert.equal(result.status, 1, output);
  assert.match(output, /@anhlp\/alp-core: forbidden Paseo dependency @getpaseo\/plugin/);
  assert.match(output, /packages\/core\/src\/index\.ts: forbidden @getpaseo dependency in core package/);
  // The createRequire alias must be followed, not just the bare require in the fixture's daemon.
  assert.match(output, /packages\/daemon\/src\/index\.ts: forbidden @getpaseo dependency in core package: @getpaseo\/plugin/);
  assert.match(output, /@anhlp\/alp-daemon: depends on @anhlp\/alp-tui, which lives in apps\/tui/);
  assert.match(output, /packages\/daemon\/src\/escape\.ts: relative import escapes package: \.\.\/\.\.\/outside\.js/);
});

test('the CLI may bundle the private gateway only as a devDependency; other packages may not depend on it', async t => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'alp-bundled-app-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const write = async (relative, contents) => { await mkdir(path.dirname(path.join(fixture, relative)), { recursive: true }); await writeFile(path.join(fixture, relative), contents); };
  const check = () => { const result = spawnSync(process.execPath, ['scripts/check-boundaries.mjs', '--root', fixture], { cwd: root, encoding: 'utf8' }); return { status: result.status, output: result.stdout + result.stderr }; };
  await write('package.json', JSON.stringify({ private: true, workspaces: ['packages/cli', 'packages/daemon', 'apps/gateway'] }));
  await write('apps/gateway/package.json', JSON.stringify({ name: '@anhlp/alp-gateway', version: '0.0.0', private: true }));
  await write('packages/daemon/package.json', JSON.stringify({ name: '@anhlp/alp-daemon', version: '0.0.0' }));
  await write('packages/cli/src/web/main.js', "import { createGateway } from '@anhlp/alp-gateway';\nexport default createGateway;\n");
  await write('packages/cli/package.json', JSON.stringify({ name: '@anhlp/alp-cli', version: '0.0.0', devDependencies: { '@anhlp/alp-gateway': '0.0.0' } }));
  const bundled = check();
  assert.equal(bundled.status, 0, bundled.output);
  // Only the bundle's own sources may import it: any other CLI file ships with `@anhlp/*` external.
  await write('packages/cli/src/cli.js', "import { createGateway } from '@anhlp/alp-gateway';\nexport default createGateway;\n");
  const unbundled = check();
  assert.equal(unbundled.status, 1, unbundled.output);
  assert.match(unbundled.output.replaceAll('\\', '/'), /packages\/cli\/src\/cli\.js: imports @anhlp\/alp-gateway, which only src\/web\/ \(bundled\) may import/);
  assert.doesNotMatch(unbundled.output.replaceAll('\\', '/'), /src\/web\/main\.js/);
  await rm(path.join(fixture, 'packages/cli/src/cli.js'));
  await write('packages/cli/package.json', JSON.stringify({ name: '@anhlp/alp-cli', version: '0.0.0', dependencies: { '@anhlp/alp-gateway': '0.0.0' } }));
  const installed = check();
  assert.equal(installed.status, 1, installed.output);
  assert.match(installed.output, /@anhlp\/alp-cli: bundles @anhlp\/alp-gateway, so it may name it only as a devDependency/);
  await write('packages/cli/package.json', JSON.stringify({ name: '@anhlp/alp-cli', version: '0.0.0', devDependencies: { '@anhlp/alp-gateway': '0.0.0' } }));
  await write('packages/daemon/package.json', JSON.stringify({ name: '@anhlp/alp-daemon', version: '0.0.0', devDependencies: { '@anhlp/alp-gateway': '0.0.0' } }));
  const other = check();
  assert.equal(other.status, 1, other.output);
  assert.match(other.output, /@anhlp\/alp-daemon: forbidden package dependency @anhlp\/alp-gateway/);
  assert.match(other.output, /@anhlp\/alp-daemon: depends on @anhlp\/alp-gateway, which lives in apps\/gateway/);
});

// Source-only checks remain useful before building; CI must reject absent build evidence.
test('strict boundary checks fail when build artifacts are missing', async t => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'alp-missing-artifacts-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await writeFile(path.join(fixture, 'package.json'), JSON.stringify({ workspaces: [] }));
  const check = (...args) => spawnSync(process.execPath, ['scripts/check-boundaries.mjs', '--root', fixture, ...args], { cwd: root, encoding: 'utf8' });
  assert.equal(check().status, 0);
  const strict = check('--require-artifacts');
  assert.equal(strict.status, 1, strict.stdout + strict.stderr);
  assert.match(strict.stderr, /Missing or unreadable build artifact/);
  assert.match(strict.stderr, /build-manifest\.json/);
  assert.match(strict.stderr, /alpd\.js/);
});

test('root distribution boundary rejects direct/optional/peer/dev/bundled SDK and plugin artifacts', async t => {
  const { corePackageProblems } = await import('../../scripts/core-package-boundary.mjs');
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
    assert.match(corePackageProblems({ name: '@anhlp/alp', [field]: { '@getpaseo/plugin': '*' } }).join('\n'), /forbidden Paseo dependency/);
  }
  for (const field of ['bundledDependencies', 'bundleDependencies']) {
    assert.match(corePackageProblems({ name: '@anhlp/alp', [field]: ['@getpaseo/plugin'] }).join('\n'), /forbidden Paseo bundle/);
  }
  for (const file of ['integrations/web.json', 'integrations/paseo.json', 'integrations/paseo/server/dist/main.js', 'node_modules/@getpaseo/plugin/package.json']) {
    assert.match(corePackageProblems({ name: '@anhlp/alp' }, [file]).join('\n'), /forbidden core artifact/);
  }
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'alp-root-boundary-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await writeFile(path.join(fixture, 'package.json'), JSON.stringify({ name: '@anhlp/alp', workspaces: [], dependencies: { '@getpaseo/plugin': '*' } }));
  const result = spawnSync(process.execPath, ['scripts/check-boundaries.mjs', '--root', fixture], { encoding: 'utf8', cwd: root });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /@anhlp\/alp: forbidden Paseo dependency/);
});

test('the Paseo remote bundle gate rejects local-only inputs and host imports', async () => {
  const { assertRemoteInputs } = await import('../../scripts/build-manifest.mjs');
  const portable = { inputs: { 'packages/client/src/portable.js': {}, 'packages/client/src/rpc/index.js': {}, 'integrations/paseo/server/provider-core.ts': {}, 'integrations/paseo/server/remote/link.ts': {} }, outputs: { 'out.js': { imports: [{ path: 'ws', external: true }, { path: 'node:crypto', external: true }] } } };
  assert.doesNotThrow(() => assertRemoteInputs(portable, 'remote'));
  for (const input of ['packages/core/src/index.ts', 'packages/runtime/src/index.ts', 'packages/daemon/src/server.ts', 'packages/client/src/index.js', 'packages/client/src/supervise.js', 'integrations/paseo/server/provider.ts', 'integrations/paseo/server/mapping.ts', 'integrations/paseo/server/panel/library.ts', 'integrations/paseo/server/paseo/agents.ts']) {
    assert.throws(() => assertRemoteInputs({ inputs: { ...portable.inputs, [input]: {} }, outputs: {} }, 'remote'), new RegExp(input.replace(/[.]/g, '\\.')));
  }
  for (const external of ['fs', 'node:fs/promises', 'child_process', 'node:child_process', 'worker_threads', 'node:vm']) {
    assert.throws(() => assertRemoteInputs({ inputs: {}, outputs: { 'out.js': { imports: [{ path: external, external: true }] } } }, 'remote'), new RegExp(`external:${external}`));
  }
});
