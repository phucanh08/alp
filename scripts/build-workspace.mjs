#!/usr/bin/env node
import { build } from 'esbuild';
import { emitDeclarations } from './declarations.mjs';
import { cp, mkdir, readdir, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, resources, requireShim, sourceConditions, syncCoreTemplates } from './workspace-build-lib.mjs';

const selected = process.argv[2] === 'paseo-plugin' ? 'paseo' : process.argv[2];
const locations = { paseo: 'packages/paseo' };
const visited = new Set();
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
  const files = await readdir(path.join(directory, 'src'), { recursive: true });
  for (const file of files.filter(file => /\.(ts|js)$/.test(file) && !file.endsWith('.d.ts'))) {
    await build({ absWorkingDir: ROOT, entryPoints: [path.join(directory, 'src', file)], outfile: path.join(directory, 'dist', file.replace(/\.ts$/, '.js')), bundle: true, format: 'esm', platform: 'node', target: 'node20', conditions: sourceConditions, external: ['./*', '../*', '@anhlp/*'], packages: 'external', plugins,
      define: { __ALP_VERSION__: JSON.stringify(manifest.version) } });
  }
  await emitDeclarations(directory, files);
  // Canonical executable bundles carry their resources and run without the repository.
  if (name === 'daemon' || name === 'cli') {
    await build({ absWorkingDir: ROOT, entryPoints: ['packages/daemon/src/main.ts'], outfile: path.join(directory, 'dist/alpd.js'), bundle: true, format: 'esm', platform: 'node', target: 'node20', conditions: sourceConditions, external: ['@anthropic-ai/claude-agent-sdk'], plugins, banner: requireShim, define: { __ALP_VERSION__: JSON.stringify(manifest.version) } });
    if (await access(path.join(ROOT, 'dist/web-app')).then(() => true, () => false)) {
      await cp(path.join(ROOT, 'dist/web-app'), path.join(directory, 'dist/web-app'), { recursive: true });
    }
  }
  if (name === 'cli') {
    await build({ absWorkingDir: ROOT, entryPoints: ['packages/cli/src/acp/main.ts'], outfile: path.join(directory, 'dist/acp.js'), bundle: true, format: 'esm', platform: 'node', target: 'node20', conditions: sourceConditions, define: { __ALP_VERSION__: JSON.stringify(manifest.version) } });
    await cp(path.join(ROOT, 'dist', 'alpd.js'), path.join(directory, 'dist', 'alpd.js'));
  }
  console.log(`Built ${manifest.name}@${manifest.version}`);
}
if (!selected) throw new Error('Usage: build-workspace.mjs <protocol|core|runtime|client|daemon|cli|paseo>');
// Build scripts may be invoked by npm from any workspace directory.
process.chdir(ROOT);
await compile(selected);
