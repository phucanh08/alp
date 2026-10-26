#!/usr/bin/env node
import { build } from 'esbuild';
import { emitDeclarations } from './declarations.mjs';
import { cp, mkdir, readdir, readFile, access, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT, resources, requireShim, sourceConditions, syncCoreTemplates } from './workspace-build-lib.mjs';
import { assertCoreInputs, recordBundle, writeBuildManifest } from './build-manifest.mjs';
import { THIRD_PARTY_NOTICES, writeThirdPartyNotices } from './third-party-notices.mjs';
import { buildAlpWeb } from './build-alp-web.mjs';

const selected = process.argv[2] === 'paseo-plugin' ? 'paseo' : process.argv[2];
const locations = { paseo: 'integrations/paseo', tui: 'apps/tui', gateway: 'apps/gateway' };
const visited = new Set();
/** Whether this checkout carries the gateway and the web app alp-web is built from. */
const webSources = () => existsSync(path.join(ROOT, 'apps/gateway/package.json')) && existsSync(path.join(ROOT, 'apps/web/package.json'));
await syncCoreTemplates();
let embeddedResources;
const embedded = async () => embeddedResources ??= await resources();
async function compile(name) {
  if (visited.has(name)) return;
  visited.add(name);
  const directory = path.join(ROOT, locations[name] ?? `packages/${name}`);
  const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    if (dependency.startsWith('@anhlp/alp-')) await compile(dependency.slice('@anhlp/alp-'.length));
  }
  if (name === 'paseo') {
    await import('./build-paseo.mjs');
    return;
  }
  const plugins = ['daemon', 'cli'].includes(name) ? await embedded() : [];
  const entries = {};
  const metafiles = [];
  const record = (file, result) => { metafiles.push(result.metafile); return recordBundle(entries, path.relative(ROOT, file), result); };
  // The CLI's alp-web service (src/web) ships only as the self-contained dist/alp-web.js below: it
  // inlines the private gateway, so it has no per-file artifacts or declarations.
  const bundledOnly = name === 'cli' ? file => file.split(path.sep)[0] === 'web' : () => false;
  const files = (await readdir(path.join(directory, 'src'), { recursive: true })).filter(file => !bundledOnly(file));
  for (const file of files.filter(file => /\.(ts|js)$/.test(file) && !file.endsWith('.d.ts'))) {
    const outfile = path.join(directory, 'dist', file.replace(/\.ts$/, '.js'));
    const result = await build({ absWorkingDir: ROOT, entryPoints: [path.join(directory, 'src', file)], outfile, bundle: true, format: 'esm', platform: 'node', target: 'node20', conditions: sourceConditions, external: ['./*', '../*', '@anhlp/*'], packages: 'external', plugins, metafile: true,
      define: { __ALP_VERSION__: JSON.stringify(manifest.version) } });
    // Every core workspace artifact is guarded, not just the executables: neither direction may
    // reach the optional Paseo plugin or its SDK.
    assertCoreInputs(result.metafile, path.relative(ROOT, outfile));
  }
  await emitDeclarations(directory, files);
  // Canonical executable bundles carry their resources and run without the repository.
  if (name === 'daemon' || name === 'cli') {
    record(path.join(directory, 'dist/alpd.js'), await build({ absWorkingDir: ROOT, entryPoints: ['packages/daemon/src/main.ts'], outfile: path.join(directory, 'dist/alpd.js'), bundle: true, format: 'esm', platform: 'node', target: 'node20', conditions: sourceConditions, external: ['@anthropic-ai/claude-agent-sdk', 'node-pty'], plugins, banner: requireShim, define: { __ALP_VERSION__: JSON.stringify(manifest.version) }, metafile: true }));
  }
  if (name === 'cli') {
    record(path.join(directory, 'dist/acp.js'), await build({ absWorkingDir: ROOT, entryPoints: ['packages/cli/src/acp/main.ts'], outfile: path.join(directory, 'dist/acp.js'), bundle: true, format: 'esm', platform: 'node', target: 'node20', conditions: sourceConditions, define: { __ALP_VERSION__: JSON.stringify(manifest.version) }, metafile: true }));
    // `alp web`'s service: the gateway (a private workspace) and ws inlined, the browser files beside it.
    // A core-only source copy (scripts/core-standalone-smoke.mjs) has neither app and builds without it.
    if (webSources()) {
      record(path.join(directory, 'dist/alp-web.js'), await build({ absWorkingDir: ROOT, entryPoints: ['packages/cli/src/web/main.js'], outfile: path.join(directory, 'dist/alp-web.js'), bundle: true, format: 'esm', platform: 'node', target: 'node20', conditions: sourceConditions, banner: requireShim, define: { __ALP_VERSION__: JSON.stringify(manifest.version) }, metafile: true }));
      await buildAlpWeb();
    } else console.log('Skipped alp-web: this source has no apps/gateway or apps/web (a core-only copy)');
  }
  // The executable bundles inline third-party packages; their licences ship beside them.
  if (metafiles.length) await writeThirdPartyNotices(path.join(directory, 'dist', THIRD_PARTY_NOTICES), metafiles, manifest.name);
  // A removed module must not keep shipping: drop any generated file whose source is gone, so the
  // published package never carries an unexported leftover from an earlier build (for example the old
  // daemon `web.js` after the web surface moved to the plugin).
  const expected = new Set(['build-manifest.json']);
  for (const file of files) {
    // Hand-written `src/*.d.ts` companions are copied to `dist` as-is and must survive the prune.
    if (file.endsWith('.d.ts')) { expected.add(file); continue; }
    if (!/\.(ts|js)$/.test(file)) continue;
    expected.add(file.replace(/\.ts$/, '.js'));
    expected.add(file.replace(/\.(ts|js)$/, '.d.ts'));
  }
  if (name === 'daemon' || name === 'cli') expected.add('alpd.js').add(THIRD_PARTY_NOTICES);
  if (name === 'cli') expected.add('acp.js').add('alp-web.js');
  const dist = path.join(directory, 'dist');
  for (const entry of await readdir(dist, { recursive: true, withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile()) continue;
    const file = path.relative(dist, path.join(entry.parentPath ?? entry.path, entry.name));
    // build-alp-web.mjs replaces the browser files whole on each build.
    if (name === 'cli' && file.split(path.sep)[0] === 'alp-web') continue;
    if (!expected.has(file)) await rm(path.join(dist, file), { force: true });
  }
  // Record the canonical bundle inputs and externals so check-boundaries can prove core neutrality.
  if (Object.keys(entries).length) await writeBuildManifest(path.join(directory, 'dist/build-manifest.json'), { version: manifest.version, entries });
  console.log(`Built ${manifest.name}@${manifest.version}`);
}
if (!selected) throw new Error('Usage: build-workspace.mjs <protocol|core|runtime|client|daemon|cli|gateway|paseo>');
// Build scripts may be invoked by npm from any workspace directory.
process.chdir(ROOT);
await compile(selected);
