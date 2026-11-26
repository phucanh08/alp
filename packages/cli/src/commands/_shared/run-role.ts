import { pathToFileURL } from 'node:url';

/**
 * The role subcommands (t-1e02): `alp daemon run`, `alp dashboard serve` and `alp bridge acp|antigravity`
 * run alpd, alp-dashboard and the MCP bridges in this process: they import the same scripts that
 * `node alpd.js` and `node alp-dashboard.js` run. Services and MCP entries written by the single-file
 * executable of 0.0.1-beta.5/6 still name them.
 *
 * The role's module reads its options from process.argv as when run directly, so argv is rewritten
 * to `[runtime, entry, ...args]` before the module loads.
 *
 * @param file the role's script beside this CLI
 */
export async function runRole(role: 'daemon' | 'dashboard' | 'acp', file: string, args: string[]) {
  process.argv = [process.argv[0], file, ...args];
  return import(pathToFileURL(file).href);
}
