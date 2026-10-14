import { writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The neutral core bundles must be buildable without the optional Paseo integration. esbuild's
 * metafile is the proof: any input under the plugin workspace, the plugin package or the Paseo SDK
 * means a core workspace reached across the seam, and any external import of them means it would
 * at runtime. Both directions are rejected, not just reported. The manifest keeps only a small,
 * reviewable summary (workspace inputs and external packages per bundle), not esbuild's full map.
 */

const normalize = file => file.replaceAll('\\', '/');
const FORBIDDEN = [
  /integrations\/paseo\//,
  /(^|\/)node_modules\/@getpaseo\//,
  /(^|\/)node_modules\/alp-paseo-plugin\//,
  /^@getpaseo(\/|$)/,
  /^alp-paseo-plugin(\/|$)/,
];

export function assertCoreInputs(metafile, label) {
  const offenders = new Set();
  for (const input of Object.keys(metafile?.inputs ?? {})) {
    const file = normalize(input);
    if (FORBIDDEN.some(pattern => pattern.test(file))) offenders.add(file);
  }
  for (const output of Object.values(metafile?.outputs ?? {})) {
    for (const entry of output.imports ?? []) {
      if (entry.external && FORBIDDEN.some(pattern => pattern.test(normalize(entry.path)))) offenders.add(`external:${entry.path}`);
    }
  }
  if (offenders.size) throw new Error(`${label}: core bundle reached the optional Paseo integration:\n  ${[...offenders].join('\n  ')}`);
}

/** Workspace inputs (packages/*) and external imports of one bundle, small and deterministic. */
export function summarize(metafile, outfile) {
  const output = metafile.outputs[outfile] ?? Object.values(metafile.outputs ?? {})[0];
  const inputs = Object.keys(metafile.inputs ?? {}).map(normalize).filter(file => file.startsWith('packages/')).sort();
  const external = [...new Set((output?.imports ?? []).filter(entry => entry.external).map(entry => entry.path))].sort();
  return { inputs, external };
}

/** Guards a build result and folds it into `entries` keyed by its output file. */
export function recordBundle(entries, outfile, result) {
  assertCoreInputs(result.metafile, outfile);
  entries[outfile] = summarize(result.metafile, outfile);
  return entries;
}

export async function writeBuildManifest(file, { version, entries }) {
  await writeFile(file, `${JSON.stringify({ version, entries }, null, 2)}\n`);
}

/** Throws when a core manifest entry names the optional Paseo workspace or SDK. */
export function validateBuildManifest(manifest) {
  const failures = [];
  for (const [outfile, entry] of Object.entries(manifest?.entries ?? {})) {
    for (const input of entry.inputs ?? []) {
      if (FORBIDDEN.some(pattern => pattern.test(normalize(input)))) failures.push(`${outfile}: core bundle input ${input}`);
    }
    for (const specifier of entry.external ?? []) {
      if (FORBIDDEN.some(pattern => pattern.test(normalize(specifier)))) failures.push(`${outfile}: core bundle imports ${specifier}`);
    }
  }
  return failures;
}

/** The canonical manifests a core distribution publishes, relative to a root. */
export function coreManifestPaths(root) {
  return ['dist/build-manifest.json', 'packages/daemon/dist/build-manifest.json', 'packages/cli/dist/build-manifest.json'].map(file => path.join(root, file));
}
