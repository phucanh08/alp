import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { daemonEntry, selfEntry } from '@anhlp/alp-core/packaged';

/** Locate artifacts in either the independently shipped CLI or the legacy root build. */
export function distributionEntry(name: string): URL {
  const entry = process.argv[1] && path.basename(process.argv[1]) === 'cli.js' ? pathToFileURL(path.resolve(process.argv[1])) : undefined;
  const candidates = [
    ...(entry ? [new URL(`../dist/${name}`, entry)] : []),
    new URL(`../dist/${name}`, import.meta.url),
    new URL(`../../../dist/${name}`, import.meta.url),
  ];
  return candidates.find(candidate => existsSync(candidate)) ?? candidates[0];
}

/** alpd.js, which `alp daemon run` runs in this process (named through app/current in the ALP bundle). */
export const DAEMON_SCRIPT = selfEntry(fileURLToPath(distributionEntry('alpd.js')));

/**
 * What starts alpd: the bundle's native alpd when it ships one (t-81b0.9), else alpd.js under Node;
 * ALP_NATIVE_DAEMON=0 keeps the Node alpd. Named through app/current in the ALP bundle.
 */
export const DAEMON_ENTRY = daemonEntry(fileURLToPath(distributionEntry('alpd.js')));
