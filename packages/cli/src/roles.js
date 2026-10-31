import { pathToFileURL } from 'node:url';
import { runBridge } from '@anhlp/alp-core/bridges';
import { UsageError } from './usage.js';

/**
 * The role subcommands (t-1e02): `alp daemon run`, `alp web serve` and `alp bridge acp|antigravity`
 * run alpd, alp-web and the MCP bridges in this process: they import the same scripts that
 * `node alpd.js` and `node alp-web.js` run. Services and MCP entries written by the single-file
 * executable of 0.0.1-beta.5/6 still name them.
 *
 * The role's module reads its options from process.argv as when run directly, so argv is rewritten
 * to `[runtime, entry, ...args]` before the module loads.
 * @param {'daemon' | 'web' | 'acp'} role
 * @param {string} file the role's script beside this CLI
 * @param {string[]} args
 */
export async function runRole(role, file, args) {
  process.argv = [process.argv[0], file, ...args];
  return import(pathToFileURL(file).href);
}

/** alp bridge acp|antigravity: the stdio MCP bridge an agent CLI starts to reach alpd's tools. @param {string[]} args */
export function bridgeCommand(args) {
  if (args.length !== 1 || !['acp', 'antigravity'].includes(args[0])) throw new UsageError();
  runBridge(args[0]);
}
