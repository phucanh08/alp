import { buildCore } from './build-core.mjs';
import { build as esbuild } from 'esbuild';
// Every plugin bundle's metafile is kept: the third-party packages they inline ship their licences.
const metafiles = [];
const build = async options => {
  const result = await esbuild({ absWorkingDir: path.resolve(import.meta.dirname, '..'), conditions: ['alp-source'], metafile: true, ...options });
  metafiles.push(result.metafile);
  return result;
};
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { requireShim } from './workspace-build-lib.mjs';
import { assertCoreInputs, assertRemoteInputs } from './build-manifest.mjs';
import { THIRD_PARTY_NOTICES, writeThirdPartyNotices } from './third-party-notices.mjs';

process.chdir(path.resolve(import.meta.dirname, '..'));

// The optional plugin ships beside the neutral core; build the core bundles first so a full
// `npm run build:paseo` also produces the neutral bundles tests import from dist/.
await buildCore({ log: message => console.log(message) });

// The plugin's client side as the ALP web app runs it (ALPD §62 step 7): compiled as Paseo's daemon
// compiles a plugin's client bundle, and embedded in the plugin's server, which serves it at /alp-plugins.js.
const PLUGIN_SDK = ['@getpaseo/plugin', '@getpaseo/plugin/*', 'react', 'react/jsx-runtime', 'react-native', '@tanstack/react-query', 'zod'];
const pluginClientBuild = await build({ entryPoints: ['integrations/paseo/index.client.tsx'], bundle: true, write: false, format: 'cjs', jsx: 'automatic', platform: 'neutral', target: 'es2020', mainFields: ['module', 'main'], supported: { 'async-await': false }, external: PLUGIN_SDK, legalComments: 'none' });
const pluginManifest = JSON.parse(await readFile('integrations/paseo/paseo-plugin.json', 'utf8'));
// Paseo makes re-exports eager for Hermes and wraps the module in a function of `require`.
const pluginCode = pluginClientBuild.outputFiles[0].text.replaceAll('get: () => from[key]', 'value: from[key]');
const pluginClient = { id: pluginManifest.id, requirements: pluginManifest.requirements, factory: `(function(require){const module={exports:{}};const exports=module.exports;${pluginCode}\nreturn module.exports;})` };

// Plugin resources: the plugin's own templates and the client bundle above. Only the plugin build
// loads these; the core bundles never see them.
const embeddedTemplates = await (await import('./workspace-build-lib.mjs')).resources();
const embeddedPluginClient = {
  name: 'embedded-alp-plugin-client',
  setup(builder) {
    builder.onResolve({ filter: /^alp:plugin-client$/ }, () => ({ path: 'plugin-client', namespace: 'alp-plugin-client' }));
    builder.onLoad({ filter: /.*/, namespace: 'alp-plugin-client' }, () => ({ contents: `export default ${JSON.stringify(pluginClient)}`, loader: 'js' }));
  },
};

const pluginPlugins = [...embeddedTemplates, embeddedPluginClient];
const pluginDefine = { __ALP_DAEMON_ENTRY__: JSON.stringify(path.resolve('integrations/paseo/server/dist/alpd.js')) };
const pluginExternal = ['@getpaseo/plugin', '@getpaseo/plugin/*', '@anthropic-ai/claude-agent-sdk'];

// The server entry (Paseo re-bundles it, so it also learns where its alpd was built) and the
// integration entry the CLI discovers.
await build({ entryPoints: ['integrations/paseo/server/index.ts'], outfile: 'integrations/paseo/server/dist/index.js', bundle: true, format: 'esm', platform: 'node', target: 'node20', banner: requireShim, external: pluginExternal, plugins: pluginPlugins, define: pluginDefine });
await build({ entryPoints: ['integrations/paseo/server/main.ts'], outfile: 'integrations/paseo/server/dist/main.js', bundle: true, format: 'esm', platform: 'node', target: 'node20', banner: requireShim, external: pluginExternal, plugins: pluginPlugins, define: pluginDefine });

// alpd next to the plugin bundle, so an installed plugin can start it. Identical to the neutral core
// alpd (the daemon never imports the plugin), built with templates only.
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const pluginAlpd = await build({ entryPoints: ['packages/daemon/src/main.ts'], outfile: 'integrations/paseo/server/dist/alpd.js', bundle: true, format: 'esm', platform: 'node', target: 'node20', external: ['@anthropic-ai/claude-agent-sdk'], plugins: embeddedTemplates, define: { __ALP_VERSION__: JSON.stringify(version) }, banner: requireShim, metafile: true });
// alpd is a core bundle even here: it must not reach the plugin or the Paseo SDK in either direction.
assertCoreInputs(pluginAlpd.metafile, 'integrations/paseo/server/dist/alpd.js');

// Declarations and per-file artifacts for the plugin's server subpaths (exports ./paseo/*, ./panel/*).
const { emitPluginDeclarations } = await import('./declarations.mjs');
await emitPluginDeclarations();
// index.ts and main.ts are already emitted as self-contained bundles above (the package "." and
// "./main"); these are the source subpaths behind exports ./web, ./paseo/* and ./panel/*.
const bundledEntries = new Set([`index.ts`, `main.ts`]);
const serverFiles = (await readdir(path.join('integrations/paseo/server'), { recursive: true }))
  .filter(file => /\.ts$/.test(file) && !file.endsWith('.d.ts') && !file.endsWith('.client.ts') && !bundledEntries.has(file));
for (const file of serverFiles) {
  await build({ entryPoints: [`integrations/paseo/server/${file}`], outfile: `integrations/paseo/server/dist/${file.replace(/\.ts$/, '.js')}`, bundle: true, format: 'esm', platform: 'node', target: 'node20', banner: requireShim, external: pluginExternal, plugins: pluginPlugins, define: pluginDefine });
}
// The remote entry (docs/alp/paseo-remote.md) reaches alpd only through the gateway: its whole
// bundle, transitively, must hold no core, runtime or daemon code and no module that reads files or
// starts processes on the client's machine.
const remoteBuild = await build({ entryPoints: ['integrations/paseo/server/remote/index.ts'], outfile: 'integrations/paseo/server/dist/remote/index.js', bundle: true, format: 'esm', platform: 'node', target: 'node20', banner: requireShim, external: pluginExternal, metafile: true });
assertRemoteInputs(remoteBuild.metafile, 'integrations/paseo/server/dist/remote/index.js');
await writeThirdPartyNotices(path.join('integrations/paseo/server/dist', THIRD_PARTY_NOTICES), metafiles, pluginManifest.name ?? '@anhlp/alp-paseo');
console.log(`Built ${pluginManifest.name ?? '@anhlp/alp-paseo'}`);
