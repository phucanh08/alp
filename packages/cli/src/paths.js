import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

/** Locate artifacts in either the independently shipped CLI or the legacy root build. */
export function distributionEntry(name) {
  const entry = process.argv[1] && path.basename(process.argv[1]) === 'cli.js' ? pathToFileURL(path.resolve(process.argv[1])) : undefined;
  const candidates = [
    ...(entry ? [new URL(`../dist/${name}`, entry)] : []),
    new URL(`../dist/${name}`, import.meta.url),
    new URL(`../../../dist/${name}`, import.meta.url),
  ];
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0];
}

export const DAEMON_ENTRY = fileURLToPath(distributionEntry('alpd.js'));
