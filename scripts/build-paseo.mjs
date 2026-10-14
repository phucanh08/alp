import { build as esbuild } from 'esbuild';
const build = options => esbuild({ absWorkingDir: path.resolve(import.meta.dirname, '..'), conditions: ['alp-source'], ...options });
import { readFile, readdir, cp, mkdir, access } from 'node:fs/promises';
import path from 'node:path';

process.chdir(path.resolve(import.meta.dirname, '..'));
await cp('templates', 'packages/core/templates', { recursive: true });
// Legacy source clients also need the protocol's JavaScript entry points on a clean checkout.
const protocolFiles = (await readdir('packages/protocol/src')).filter(file => /\.(ts|js)$/.test(file) && !file.endsWith('.d.ts'));
await build({ entryPoints: protocolFiles.map(file => `packages/protocol/src/${file}`), outdir: 'packages/protocol/dist', bundle: false, format: 'esm', platform: 'node', target: 'node20' });
const templateFiles = await readdir('templates', { recursive: true, withFileTypes: true });
const templates = {};
for (const entry of templateFiles) {
  if (!entry.isFile()) continue;
  const relative = `${entry.parentPath}/${entry.name}`.replace(/^templates[\\/]/, '').replaceAll('\\', '/');
  templates[relative] = await readFile(`templates/${relative}`, 'utf8');
}
const embeddedTemplates = {
  name: 'embedded-alp-templates',
  setup(build) {
    build.onResolve({ filter: /^alp:templates$/ }, () => ({ path: 'templates', namespace: 'alp' }));
    build.onLoad({ filter: /.*/, namespace: 'alp' }, () => ({ contents: `export default ${JSON.stringify(templates)}`, loader: 'js' }));
  },
};

// The plugin's client side as the ALP web app runs it (ALPD §62 step 7): compiled as Paseo's daemon
// compiles a plugin's client bundle, and embedded in alpd, which serves it at /alp-plugins.js.
const PLUGIN_SDK = ['@getpaseo/plugin', '@getpaseo/plugin/*', 'react', 'react/jsx-runtime', 'react-native', '@tanstack/react-query', 'zod'];
const pluginClientBuild = await build({ entryPoints: ['packages/paseo/index.client.tsx'], bundle: true, write: false, format: 'cjs', jsx: 'automatic', platform: 'neutral', target: 'es2020', mainFields: ['module', 'main'], supported: { 'async-await': false }, external: PLUGIN_SDK, legalComments: 'none' });
const pluginManifest = JSON.parse(await readFile('packages/paseo/paseo-plugin.json', 'utf8'));
// Paseo makes re-exports eager for Hermes and wraps the module in a function of `require`.
const pluginCode = pluginClientBuild.outputFiles[0].text.replaceAll('get: () => from[key]', 'value: from[key]');
const pluginClient = { id: pluginManifest.id, requirements: pluginManifest.requirements, factory: `(function(require){const module={exports:{}};const exports=module.exports;${pluginCode}\nreturn module.exports;})` };
const embeddedPluginClient = {
  name: 'embedded-alp-plugin-client',
  setup(build) {
    build.onResolve({ filter: /^alp:plugin-client$/ }, () => ({ path: 'plugin-client', namespace: 'alp-plugin-client' }));
    build.onLoad({ filter: /.*/, namespace: 'alp-plugin-client' }, () => ({ contents: `export default ${JSON.stringify(pluginClient)}`, loader: 'js' }));
  },
};

// ws and the MCP SDK's process launcher are CommonJS: Node bundles get a require of their own.
const requireShim = { js: "import { createRequire as __alpRequire } from 'node:module'; const require = __alpRequire(typeof import.meta.url === 'string' ? import.meta.url : process.cwd() + '/__alp_require__.js');" };
// Paseo re-bundles plugin code, so the plugin also learns where its alpd was built.
await build({ entryPoints: ['packages/paseo/server/index.ts'], outfile: 'packages/paseo/server/dist/index.js', bundle: true, format: 'esm', platform: 'node', target: 'node20', banner: requireShim, external: ['@getpaseo/plugin', '@getpaseo/plugin/*', '@anthropic-ai/claude-agent-sdk'], plugins: [embeddedTemplates], define: { __ALP_DAEMON_ENTRY__: JSON.stringify(path.resolve('packages/paseo/server/dist/alpd.js')) } });

// The viewer-neutral runtime and the daemon server on their own, for tests.
for (const [entry, outfile] of [['packages/runtime/src/index.ts', 'dist/runtime/index.js'], ['packages/daemon/src/index.ts', 'dist/daemon/index.js']]) {
  await build({ entryPoints: [entry], outfile, bundle: true, format: 'esm', platform: 'node', target: 'node20', banner: requireShim, external: ['@anthropic-ai/claude-agent-sdk'], ...(entry.includes('daemon') ? { plugins: [embeddedTemplates, embeddedPluginClient] } : {}) });
}

// alp acp: the ACP agent the CLI loads (ALPD §60).
await build({ entryPoints: ['packages/cli/src/acp/main.ts'], outfile: 'dist/acp.js', bundle: true, format: 'esm', platform: 'node', target: 'node20', define: { __ALP_VERSION__: JSON.stringify(JSON.parse(await readFile('package.json', 'utf8')).version) } });
// The ACP agent on its own, for tests.
await build({ entryPoints: ['packages/cli/src/acp/agent.ts'], outfile: 'dist/acp/agent.js', bundle: true, format: 'esm', platform: 'node', target: 'node20' });

// alpd: for the CLI, and next to the plugin bundle so an installed plugin can start it.
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
for (const outfile of ['dist/alpd.js', 'packages/paseo/server/dist/alpd.js']) {
  await build({ entryPoints: ['packages/daemon/src/main.ts'], outfile, bundle: true, format: 'esm', platform: 'node', target: 'node20', external: ['@anthropic-ai/claude-agent-sdk'], plugins: [embeddedTemplates, embeddedPluginClient], define: { __ALP_VERSION__: JSON.stringify(version) }, banner: requireShim });
}
