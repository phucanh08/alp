// Lists the third-party packages esbuild inlines into each shipped executable bundle, by
// re-running the repo's bundle configurations in memory (write: false). Nothing in the
// checkout is written: the build-time resource plugins (templates, plugin client) are stubbed,
// since they embed only ALP's own text, never npm packages.
// Usage: node bundle-inputs.mjs <repoRoot> <out.json>
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [root, outPath] = process.argv.slice(2);
const require = createRequire(path.join(root, 'package.json'));
const { build } = require('esbuild');
const NM = 'node' + '_modules';

const stub = { name: 'stub-resources', setup(b) {
  b.onResolve({ filter: /^alp:(templates|plugin-client)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
  b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default {}', loader: 'js' }));
} };
const common = { absWorkingDir: root, bundle: true, write: false, metafile: true, format: 'esm', platform: 'node', target: 'node20', conditions: ['alp-source'], plugins: [stub], logLevel: 'silent', define: { __ALP_VERSION__: '"0"', __ALP_DAEMON_ENTRY__: '"x"' } };
const pluginExternal = ['@getpaseo/plugin', '@getpaseo/plugin/*', '@anthropic-ai/claude-agent-sdk'];
const PLUGIN_SDK = ['@getpaseo/plugin', '@getpaseo/plugin/*', 'react', 'react/jsx-runtime', 'react-native', '@tanstack/react-query', 'zod'];

// Which tarball ships each bundle (from package.json "files"/build scripts).
const bundles = [
  { ships: ['@anhlp/alp', '@anhlp/alp-cli', '@anhlp/alp-daemon'], label: 'alpd.js', entry: 'packages/daemon/src/main.ts', external: ['@anthropic-ai/claude-agent-sdk'] },
  { ships: ['@anhlp/alp', '@anhlp/alp-cli'], label: 'acp.js', entry: 'packages/cli/src/acp/main.ts', external: [] },
  { ships: ['@anhlp/alp-paseo'], label: 'plugin server/alpd.js', entry: 'packages/daemon/src/main.ts', external: ['@anthropic-ai/claude-agent-sdk'] },
  { ships: ['@anhlp/alp-paseo'], label: 'plugin client (alp-plugins.js)', entry: 'integrations/paseo/index.client.tsx', external: PLUGIN_SDK, extra: { format: 'cjs', jsx: 'automatic', platform: 'neutral', target: 'es2020', mainFields: ['module', 'main'] } },
];
const serverDir = path.join(root, 'integrations/paseo/server');
for (const f of readdirSync(serverDir, { recursive: true })) {
  const file = String(f).replaceAll('\\', '/');
  if (!/\.ts$/.test(file) || file.endsWith('.d.ts') || file.endsWith('.client.ts') || file.startsWith('dist/')) continue;
  bundles.push({ ships: ['@anhlp/alp-paseo'], label: `plugin server/${file}`, entry: `integrations/paseo/server/${file}`, external: pluginExternal });
}

function pkgOf(input) {
  const p = input.replaceAll('\\', '/');
  const i = p.lastIndexOf(NM + '/');
  if (i < 0) return null;
  const rest = p.slice(i + NM.length + 1).split('/');
  const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
  const dir = p.slice(0, i + NM.length + 1) + name;
  let version = '?';
  try { version = JSON.parse(readFileSync(path.join(root, dir, 'package.json'), 'utf8')).version; } catch {}
  return { name, version, dir };
}

const result = {};
const union = {};
for (const b of bundles) {
  try {
    const r = await build({ ...common, entryPoints: [b.entry], external: b.external, ...(b.extra || {}) });
    const pk = new Map();
    for (const input of Object.keys(r.metafile.inputs)) { const p = pkgOf(input); if (p) pk.set(`${p.name}@${p.version}`, p.dir); }
    const externals = new Set();
    for (const o of Object.values(r.metafile.outputs)) for (const im of o.imports || []) if (im.external && !im.path.startsWith('node:')) externals.add(im.path);
    result[b.label] = { ships: b.ships, inlined: [...pk.keys()].sort(), external: [...externals].sort() };
    for (const k of pk.keys()) (union[k] ||= new Set()).add(b.label);
  } catch (e) {
    result[b.label] = { ships: b.ships, error: String(e.message).slice(0, 400) };
  }
}
writeFileSync(outPath, JSON.stringify({ bundles: result, union: Object.fromEntries(Object.entries(union).map(([k, v]) => [k, [...v]])) }, null, 1));
for (const [k, v] of Object.entries(result)) console.log(k, v.error ? `ERROR ${v.error}` : `inlined=${v.inlined.length} external=${v.external.length}`);
console.log('\nUNION of inlined third-party:');
for (const k of Object.keys(union).sort()) console.log('  ' + k);
