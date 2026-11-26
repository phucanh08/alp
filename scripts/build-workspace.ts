#!/usr/bin/env node
import { copyTerminalNative } from './terminal-native-assets.ts';
import { build } from 'esbuild';
import { emitDeclarations } from './declarations.ts';
import { cp, mkdir, readdir, readFile, access, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT, resources, requireShim, sourceConditions, syncCoreTemplates } from './workspace-build-lib.ts';
import { assertCoreInputs, recordBundle, writeBuildManifest } from './build-manifest.ts';
import { THIRD_PARTY_NOTICES, writeThirdPartyNotices } from './third-party-notices.ts';
import { buildAlpDashboard } from './build-alp-dashboard.ts';

const selected = process.argv[2] === 'paseo-plugin' ? 'paseo' : process.argv[2];
const locations: Record<string,string> = { paseo: 'integrations/paseo', tui: 'apps/tui', gateway: 'apps/gateway' };
const visited = new Set();
/** Whether this checkout carries the gateway and the web app alp-dashboard is built from. */
const webSources = () => existsSync(path.join(ROOT, 'apps/gateway/package.json')) && existsSync(path.join(ROOT, 'apps/web/package.json'));
await syncCoreTemplates();
let embeddedResources: import('esbuild').Plugin[]|undefined;
const embedded = async () => embeddedResources ??= await resources();
async function compile(name: string) {
  if (visited.has(name)) return;
  visited.add(name);
  const directory = path.join(ROOT, locations[name] ?? `packages/${name}`);
  const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    if (dependency.startsWith('@anhlp/alp-')) await compile(dependency.slice('@anhlp/alp-'.length));
  }
  if (name === 'paseo') {
    await import('./build-paseo.ts');
    return;
  }
  const plugins = ['daemon', 'cli'].includes(name) ? await embedded() : [];
  const entries: Record<string,import('./build-manifest.ts').BundleSummary> = {};
  const metafiles: import('esbuild').Metafile[] = [];
  const record = (file: string, result: { metafile: import('esbuild').Metafile; }) => { metafiles.push(result.metafile); return recordBundle(entries, path.relative(ROOT, file), result); };
  // The CLI's alp-dashboard service (src/dashboard) ships only as the self-contained dist/alp-dashboard.js below: it
  // inlines the private gateway, so it has no declarations. Its per-file JavaScript (dist/dashboard/, which the
  // package's `files` leaves out) is built only for the CLI's own tests, which cannot load the TypeScript sources.
  const bundledOnly = name === 'cli' ? (file: string) => file.split(path.sep)[0] === 'dashboard' : () => false;
  const sources = await readdir(path.join(directory, 'src'), { recursive: true });
  const files = sources.filter(file => !bundledOnly(file));
  for (const file of sources.filter(file => /\.(ts|js)$/.test(file) && !file.endsWith('.d.ts'))) {
    const outfile = path.join(directory, 'dist', file.replace(/\.ts$/, '.js'));
    // Sources name their siblings with `.ts` specifiers so Node runs them directly; the per-file dist
    // keeps them external and imports the built `.js` sibling instead (alp-ts-specifiers). A no-op for `.js` specifiers.
    const result = await build({ absWorkingDir: ROOT, entryPoints: [path.join(directory, 'src', file)], outfile, bundle: true, format: 'esm', platform: 'node', target: 'node20', conditions: sourceConditions, external: ['./*', '../*', '@anhlp/*'], packages: 'external',
      plugins: [...plugins, { name: 'alp-ts-specifiers', setup(b) { b.onResolve({ filter: /^\.\.?\/.*\.ts$/ }, args => args.kind === 'entry-point' ? undefined : { path: args.path.replace(/\.ts$/, '.js'), external: true }); } }], metafile: true,
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
    // `alp dashboard`'s service: the gateway (a private workspace) and ws inlined, the browser files beside it.
    // A core-only source copy (scripts/core-standalone-smoke.ts) has neither app and builds without it.
    if (webSources()) {
      record(path.join(directory, 'dist/alp-dashboard.js'), await build({ absWorkingDir: ROOT, entryPoints: ['packages/cli/src/dashboard/main.ts'], outfile: path.join(directory, 'dist/alp-dashboard.js'), bundle: true, format: 'esm', platform: 'node', target: 'node20', conditions: sourceConditions, banner: requireShim, define: { __ALP_VERSION__: JSON.stringify(manifest.version) }, metafile: true }));
      await buildAlpDashboard();
    } else console.log('Skipped alp-dashboard: this source has no apps/gateway or apps/web (a core-only copy)');
  }
  // The executable bundles inline third-party packages; their licences ship beside them.
  if (metafiles.length) await writeThirdPartyNotices(path.join(directory, 'dist', THIRD_PARTY_NOTICES), metafiles, manifest.name);
  // A removed module must not keep shipping: drop any generated file whose source is gone, so the
  // published package never carries an unexported leftover from an earlier build (for example the old
  // daemon `web.js` after the web surface moved to the plugin).
  const expected = new Set(['build-manifest.json']);
  // The tests' per-file JavaScript of the bundled-only sources (no declarations).
  for (const file of sources.filter(file => bundledOnly(file) && /\.(ts|js)$/.test(file) && !file.endsWith('.d.ts'))) expected.add(file.replace(/\.ts$/, '.js'));
  for (const file of files) {
    // Hand-written `src/*.d.ts` companions are copied to `dist` as-is and must survive the prune.
    if (file.endsWith('.d.ts')) { expected.add(file); continue; }
    if (!/\.(ts|js)$/.test(file)) continue;
    expected.add(file.replace(/\.ts$/, '.js'));
    expected.add(file.replace(/\.(ts|js)$/, '.d.ts'));
  }
  if (name === 'daemon' || name === 'cli') expected.add('alpd.js').add(THIRD_PARTY_NOTICES);
  if (name === 'cli') expected.add('acp.js').add('alp-dashboard.js');
  const dist = path.join(directory, 'dist');
  for (const entry of await readdir(dist, { recursive: true, withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile()) continue;
    const file = path.relative(dist, path.join(entry.parentPath ?? entry.path, entry.name));
    // build-alp-dashboard.ts replaces the browser files whole on each build.
    if (name === 'cli' && file.split(path.sep)[0] === 'alp-dashboard') continue;
    if (['daemon', 'cli'].includes(name) && file.split(path.sep)[0] === 'terminal-native') continue;
    if (!expected.has(file)) await rm(path.join(dist, file), { force: true });
  }
  if (['daemon', 'cli'].includes(name)) await copyTerminalNative(path.join(directory, 'dist/terminal-native'));
  // Record the canonical bundle inputs and externals so check-boundaries can prove core neutrality.
  if (Object.keys(entries).length) await writeBuildManifest(path.join(directory, 'dist/build-manifest.json'), { version: manifest.version, entries });
  console.log(`Built ${manifest.name}@${manifest.version}`);
}
if (!selected) throw new Error('Usage: build-workspace.ts <protocol|core|runtime|client|daemon|cli|gateway|paseo>');
// Build scripts may be invoked by npm from any workspace directory.
process.chdir(ROOT);
await compile(selected);
