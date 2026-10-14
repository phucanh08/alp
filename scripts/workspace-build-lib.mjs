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
  return [{ name: 'alp-resources', setup(builder) {
    builder.onResolve({ filter: /^alp:templates$/ }, () => ({ path: 'templates', namespace: 'alp' }));
    builder.onLoad({ filter: /.*/, namespace: 'alp' }, () => ({ contents: `export default ${JSON.stringify(templates)}`, loader: 'js' }));
  } }];
}
