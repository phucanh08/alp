#!/usr/bin/env node
// @ts-check
// The JavaScript the web app's unit tests load (apps/web/tests, plain `node --test` without type
// stripping): every src/lib/**/*.ts compiled on its own into dist-lib/ with the same relative layout.
// Not apps/web/dist, which `vite build` empties. Each file keeps its imports: a relative one stays a
// relative import of the sibling output (an extensionless one gets `.js`, as Node needs), a package
// one stays bare and resolves from node_modules as before. Nothing is lowered (target esnext) and
// nothing is minified, so the tests run the same code the TypeScript holds.
import { build } from 'esbuild';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = path.resolve(import.meta.dirname, '..');
const SOURCE = path.join(WEB, 'src/lib');
const OUT = path.join(WEB, 'dist-lib');

/** @type {import('esbuild').Plugin} */
const keepRelativeImports = {
  name: 'keep-relative-imports',
  setup(builder) {
    builder.onResolve({ filter: /^\.\.?\// }, args => {
      if (args.kind === 'entry-point') return undefined;
      return { path: /\.[cm]?js$/.test(args.path) ? args.path : `${args.path}.js`, external: true };
    });
  },
};

/** Builds dist-lib/ afresh from src/lib. */
export async function buildLib() {
  const files = (await readdir(SOURCE, { recursive: true })).filter(file => file.endsWith('.ts') && !file.endsWith('.d.ts'));
  await rm(OUT, { recursive: true, force: true });
  await Promise.all(files.map(file => build({
    absWorkingDir: WEB,
    entryPoints: [path.join(SOURCE, file)],
    outfile: path.join(OUT, file.replace(/\.ts$/, '.js')),
    tsconfig: path.join(WEB, 'tsconfig.json'),
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'esnext',
    packages: 'external',
    plugins: [keepRelativeImports],
    logLevel: 'warning',
  })));
  return files.length;
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  console.log(`Built ${await buildLib()} modules of apps/web/src/lib into apps/web/dist-lib`);
}
