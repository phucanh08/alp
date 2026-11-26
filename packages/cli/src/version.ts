import { readFileSync } from 'node:fs';

declare const __ALP_VERSION__: string;

/** The version of this alp: the build's, or the package's. */
export function alpVersion() {
  return (typeof __ALP_VERSION__ === 'string' ? __ALP_VERSION__ : JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
}
