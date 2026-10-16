// @ts-check
import path from 'node:path';

/**
 * The web app's import boundary, checked on the whole module graph Vite bundles (transitive
 * imports included): the browser reaches alpd only through the portable client SDK and the
 * protocol's wire constants. ALP's core, runtime, daemon, CLI, the Node client entry, other apps,
 * Paseo and Node built-ins never enter the bundle; the build fails when one does.
 */

/** Files of the repository's own packages the bundle may hold, relative to the repository. */
const ALLOWED_ALP = [
  /^packages\/client\/src\/(portable|websocket)\.js$/,
  /^packages\/client\/src\/rpc\/[\w-]+\.js$/,
  /^packages\/protocol\/src\/(public|wire)\.js$/,
];

/** Packages from npm the bundle must never hold. */
const FORBIDDEN_PACKAGES = /(^|\/)node_modules\/(@getpaseo\/|@anhlp\/alp-paseo\/|ws\/|@anhlp\/alp-(core|runtime|daemon|cli|gateway)\/)/;

/**
 * Why a module may not be in the browser bundle, or undefined when it may.
 * @param {string} id a module id as Rollup reports it @param {string} repository the repository root
 */
export function boundaryProblem(id, repository) {
  const file = id.replaceAll('\\', '/');
  if (file.includes('__vite-browser-external') || /^\0?node:/.test(file)) return 'a Node built-in';
  if (FORBIDDEN_PACKAGES.test(file)) return 'a host-only or Paseo package';
  const relative = path.relative(repository, file.split('?')[0]).replaceAll('\\', '/');
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative.startsWith('node_modules/')) return undefined;
  if (relative.startsWith('apps/web/')) return undefined;
  if (/^(packages|integrations|apps)\//.test(relative) && !ALLOWED_ALP.some(pattern => pattern.test(relative))) return 'ALP host code outside the portable SDK';
  return undefined;
}

/** @param {{ repository: string }} options @returns {import('vite').Plugin} */
export function browserBoundary({ repository }) {
  return {
    name: 'alp-browser-boundary',
    apply: 'build',
    enforce: 'pre',
    // Each module as it enters the graph: the error names the first one that crosses.
    load(id) {
      const problem = boundaryProblem(id, repository);
      if (problem) this.error(`ALP web must reach alpd only through @anhlp/alp-client/portable and /websocket: ${path.relative(repository, id) || id} is ${problem}`);
      return null;
    },
    // And the whole graph once more, for ids no load hook saw (virtual modules, externals).
    generateBundle() {
      const problems = [];
      const sdk = [];
      for (const id of this.getModuleIds()) {
        const problem = boundaryProblem(id, repository);
        if (problem) problems.push(`${path.relative(repository, id) || id}: ${problem}`);
        const relative = path.relative(repository, id).replaceAll('\\', '/');
        if (/^packages\//.test(relative)) sdk.push(relative);
      }
      if (problems.length) this.error(`ALP web must reach alpd only through @anhlp/alp-client/portable and /websocket:\n${problems.join('\n')}`);
      // The ALP modules the bundle holds, as evidence of the boundary (no host paths).
      this.emitFile({ type: 'asset', fileName: 'alp-boundary.json', source: `${JSON.stringify({ alpModules: sdk.sort() }, null, 2)}\n` });
    },
  };
}
