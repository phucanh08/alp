#!/usr/bin/env node
// The browser files `alp dashboard` serves (packages/cli/dist/alp-dashboard.js, docs/alp/dashboard.md): apps/web built
// with its own Vite config straight into packages/cli/dist/alp-dashboard/, with a THIRD-PARTY-NOTICES.txt
// for exactly the npm packages Rollup put into the browser bundle (its module graph, not a guess).
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { THIRD_PARTY_NOTICES, packageDirectory, writeNoticesFor } from './third-party-notices.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
export const ALP_DASHBOARD_DIR = path.join(ROOT, 'packages/cli/dist/alp-dashboard');

/** The installed package directory of a Rollup module id, if it is one; virtual and query parts dropped. */
export function bundledPackage(id: string) {
  const file = id.replace(/^\0+/, '').split('?')[0];
  return packageDirectory(file);
}

/**
 * Rollup's virtual modules whose code is Vite's own, inlined into the bundle: the modulepreload
 * polyfill and preload helper (`\0vite/...`) and the CommonJS interop helpers of the
 * @rollup/plugin-commonjs Vite bundles (its LICENSE.md carries that plugin's licence).
 */
export const viteHelper = (id: string) => id.startsWith('\0vite/') || id === '\0commonjsHelpers.js';

/** The installed directory of package `name`, as Node resolves it from `from`. */
async function installedPackage(name: string, from: string): Promise<string> {
  for (let directory = from; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'node_modules', name);
    if (await access(path.join(candidate, 'package.json')).then(() => true, () => false)) return candidate;
    if (path.dirname(directory) === directory) throw new Error(`${name} is not installed (looked up from ${from})`);
  }
}

/**
 * Packages an app stylesheet pulls in with a bare `@import "<package>"`: Tailwind's Vite plugin
 * inlines them (its preflight and theme) without Rollup ever seeing them as modules.
 * @param stylesheet an absolute path
 */
export async function importedStylePackages(stylesheet: string) {
  const found: string[] = [];
  const text = await readFile(stylesheet, 'utf8');
  for (const [, specifier] of text.matchAll(/@import\s+(?:url\()?["']([^"'./][^"']*)["']/g)) {
    const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
    found.push(await installedPackage(name, path.dirname(stylesheet)));
  }
  return found;
}

/** Builds apps/web into `outDir` and writes its notices; returns the bundled npm package directories. */
export async function buildAlpDashboard({ outDir = ALP_DASHBOARD_DIR, log = console.log } = {}) {
  const { build } = await import('vite');
  const packages = new Set<string>();
  const stylesheets = new Set<string>();
  let helpers = false;
  const collect: import('vite').Plugin = {
    name: 'alp-web-third-party',
    apply: 'build',
    generateBundle() {
      for (const id of this.getModuleIds()) {
        const directory = bundledPackage(id);
        if (directory) packages.add(directory);
        else if (viteHelper(id)) helpers = true;
        else if (/\.css$/.test(id.split('?')[0]) && path.isAbsolute(id.split('?')[0])) stylesheets.add(id.split('?')[0]);
      }
    },
  };
  await build({
    configFile: path.join(ROOT, 'apps/web/vite.config.js'),
    root: path.join(ROOT, 'apps/web'),
    logLevel: 'warn',
    plugins: [collect],
    build: { outDir, emptyOutDir: true, chunkSizeWarningLimit: 2048 },
  });
  await access(path.join(outDir, 'index.html'));
  for (const stylesheet of stylesheets) for (const directory of await importedStylePackages(stylesheet)) packages.add(directory);
  if (helpers) packages.add(await installedPackage('vite', path.join(ROOT, 'apps/web')));
  if (!packages.size) throw new Error('the apps/web bundle names no npm package; the notices would be empty');
  const { headings } = await writeNoticesFor(path.join(outDir, THIRD_PARTY_NOTICES), [...packages], 'the ALP web app (packages/cli/dist/alp-dashboard)');
  const files = (await readdir(outDir, { recursive: true })).length;
  log(`Built the ALP web app: ${path.relative(ROOT, outDir)} (${files} files, ${headings.length} third-party packages)`);
  return { packages: [...packages], headings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await buildAlpDashboard();
