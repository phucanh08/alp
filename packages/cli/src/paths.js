import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { selfEntry } from '@anhlp/alp-core/packaged';

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

/** What starts alpd: alpd.js under Node (named through app/current in the ALP bundle). */
export const DAEMON_ENTRY = selfEntry(fileURLToPath(distributionEntry('alpd.js')));
