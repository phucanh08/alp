import { build } from 'esbuild';
import { readFile, readdir, cp } from 'node:fs/promises';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const sourceConditions = ['alp-source'];
export const requireShim = { js: "import { createRequire as __alpRequire } from 'node:module'; const require = __alpRequire(typeof import.meta.url === 'string' ? import.meta.url : process.cwd() + '/__alp_require__.js');" };
export async function syncCoreTemplates() {
  await cp(path.join(ROOT, 'templates'), path.join(ROOT, 'packages/core/templates'), { recursive: true });
}

export async function resources() {
  await syncCoreTemplates();
  const templates = {};
  for (const entry of await readdir(path.join(ROOT, 'packages/core/templates'), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    templates[path.relative(path.join(ROOT, 'packages/core/templates'), file).replaceAll('\\', '/')] = await readFile(file, 'utf8');
  }
  const pluginClientBuild = await build({ absWorkingDir: ROOT, entryPoints: ['packages/paseo/index.client.tsx'], bundle: true, write: false, format: 'cjs', jsx: 'automatic', platform: 'neutral', target: 'es2020', mainFields: ['module', 'main'], supported: { 'async-await': false }, external: ['@getpaseo/plugin', '@getpaseo/plugin/*', 'react', 'react/jsx-runtime', 'react-native', '@tanstack/react-query', 'zod'], legalComments: 'none' });
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'packages/paseo/paseo-plugin.json'), 'utf8'));
  const code = pluginClientBuild.outputFiles[0].text.replaceAll('get: () => from[key]', 'value: from[key]');
  const client = { id: manifest.id, requirements: manifest.requirements, factory: `(function(require){const module={exports:{}};const exports=module.exports;${code}\nreturn module.exports;})` };
  return [{ name: 'alp-resources', setup(builder) {
    builder.onResolve({ filter: /^alp:(templates|plugin-client)$/ }, args => ({ path: args.path, namespace: 'alp' }));
    builder.onLoad({ filter: /.*/, namespace: 'alp' }, args => ({ contents: `export default ${JSON.stringify(args.path === 'alp:templates' ? templates : client)}`, loader: 'js' }));
  } }];
}
