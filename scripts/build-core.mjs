#!/usr/bin/env node
// ALP's neutral core bundles: the runtime, the daemon server, alpd and the ACP agent. They embed
// only ALP's own templates, never the optional Paseo plugin's client or SDK, so the core six
// workspaces stay buildable, testable and installable on their own. The optional plugin build
// calls this too; root `npm run build` and prepack use only the neutral build path.
import { copyTerminalNative } from './terminal-native-assets.mjs';
import { build as esbuild } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, requireShim, resources } from './workspace-build-lib.mjs';
import { recordBundle, writeBuildManifest } from './build-manifest.mjs';
import { THIRD_PARTY_NOTICES, writeThirdPartyNotices } from './third-party-notices.mjs';

const root = ROOT;

export async function buildCore({ log = console.log } = {}) {
  process.chdir(root);
  const embedded = await resources();
  const { version } = JSON.parse(await readFile('package.json', 'utf8'));
  const build = (options = {}) => {
    const { plugins = [], ...rest } = options;
    return esbuild({ absWorkingDir: root, conditions: ['alp-source'], metafile: true, ...rest, plugins: [...embedded, ...plugins] });
  };

  // Legacy source clients also need the protocol's JavaScript entry points on a clean checkout.
  const protocolFiles = (await readdir('packages/protocol/src')).filter(file => /\.(ts|js)$/.test(file) && !file.endsWith('.d.ts'));
  await esbuild({ absWorkingDir: root, entryPoints: protocolFiles.map(file => `packages/protocol/src/${file}`), outdir: 'packages/protocol/dist', bundle: false, format: 'esm', platform: 'node', target: 'node20' });

  const entries = {};
  const metafiles = [];
  const record = (outfile, result) => { metafiles.push(result.metafile); return recordBundle(entries, outfile, result); };

  record('dist/runtime/index.js', await build({ entryPoints: ['packages/runtime/src/index.ts'], outfile: 'dist/runtime/index.js', bundle: true, format: 'esm', platform: 'node', target: 'node20', banner: requireShim, external: ['@anthropic-ai/claude-agent-sdk', 'node-pty'] }));
  record('dist/daemon/index.js', await build({ entryPoints: ['packages/daemon/src/index.ts'], outfile: 'dist/daemon/index.js', bundle: true, format: 'esm', platform: 'node', target: 'node20', banner: requireShim, external: ['@anthropic-ai/claude-agent-sdk', 'node-pty'] }));
  record('dist/acp.js', await build({ entryPoints: ['packages/cli/src/acp/main.ts'], outfile: 'dist/acp.js', bundle: true, format: 'esm', platform: 'node', target: 'node20', define: { __ALP_VERSION__: JSON.stringify(version) } }));
  record('dist/acp/agent.js', await build({ entryPoints: ['packages/cli/src/acp/agent.ts'], outfile: 'dist/acp/agent.js', bundle: true, format: 'esm', platform: 'node', target: 'node20' }));
  record('dist/alpd.js', await build({ entryPoints: ['packages/daemon/src/main.ts'], outfile: 'dist/alpd.js', bundle: true, format: 'esm', platform: 'node', target: 'node20', external: ['@anthropic-ai/claude-agent-sdk', 'node-pty'], define: { __ALP_VERSION__: JSON.stringify(version) }, banner: requireShim }));

  await copyTerminalNative(path.join(root, 'dist/terminal-native'));
  await copyTerminalNative(path.join(root, 'dist/daemon/terminal-native'));
  await writeBuildManifest(path.join(root, 'dist/build-manifest.json'), { version, entries });
  // The root package ships dist/alpd.js and dist/acp.js, which inline third-party packages.
  await writeThirdPartyNotices(path.join(root, 'dist', THIRD_PARTY_NOTICES), metafiles, '@anhlp/alp');
  log('Built ALP core bundles (runtime, daemon, alpd, acp) without the Paseo integration');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await buildCore();
