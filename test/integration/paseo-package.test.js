import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * The canonical Paseo plugin and the root compatibility distribution. This lives with the Paseo
 * package, not with the neutral core, because checking them requires the plugin to be built: the
 * paseo workspace test group and the full root run both build it, so these assertions are
 * unconditional and a missing build is a real failure rather than a skipped check.
 */
const root = path.resolve(import.meta.dirname, '..', '..');

test('canonical Paseo plugin and root compatibility distribution remain buildable without legacy folders', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.ok(manifest.workspaces.includes('integrations/paseo'));
  assert.ok(!manifest.workspaces.includes('integrations/paseo-plugin'));
  assert.equal(manifest.bin.alp, 'packages/cli/dist/cli.js');
  const pkg = JSON.parse(await readFile(path.join(root, 'integrations/paseo/package.json'), 'utf8'));
  assert.equal(pkg.name, '@anhlp/alp-paseo');
  assert.equal(pkg.version, manifest.version);
  const pluginManifest = await readFile(path.join(root, 'integrations/paseo/paseo-plugin.json'), 'utf8');
  assert.match(pluginManifest, /"id":/);
  for (const legacy of ['src', 'plugins/paseo', 'integrations/paseo-plugin']) {
    assert.ok(!existsSync(path.join(root, legacy)), `${legacy} must not be recreated`);
  }

  // The built plugin bundles are a prerequisite, not an optional extra.
  const loaded = await import('../../integrations/paseo/server/dist/index.js');
  assert.equal(typeof loaded.default, 'function');
  for (const file of ['index.js', 'alpd.js', 'main.js']) {
    assert.ok(existsSync(path.join(root, 'integrations/paseo/server/dist', file)), `missing plugin bundle ${file}`);
  }
  assert.ok(existsSync(path.join(root, 'packages/cli/dist/cli.js')), 'missing root CLI build');

  // The repository descriptor is a development convenience; only the plugin ships its server/web.
  const descriptor = JSON.parse(await readFile(path.join(root, 'integrations/web.json'), 'utf8'));
  assert.ok(existsSync(path.resolve(root, 'integrations', descriptor.main)));
  assert.ok(pkg.files.includes('server/dist'));
  assert.equal(pkg.bin['alp-web-integration'], 'server/dist/main.js');
  assert.ok(!manifest.files.some(entry => /integrations|web-app/.test(entry)));
  assert.ok(!manifest.dependencies['@getpaseo/plugin']);
  assert.ok(!manifest.bundledDependencies?.includes('@getpaseo/plugin'));
});
