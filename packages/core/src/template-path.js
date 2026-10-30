import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assetDir } from './packaged.js';

/** Source packages carry templates beside src; legacy bundles live one directory deeper; the ALP executable extracts its embedded copy. */
export function shippedTemplateRoot() {
  const assets = assetDir();
  if (assets) return pathToFileURL(path.join(assets, 'templates') + path.sep);
  const packaged = new URL('../templates/', import.meta.url);
  const candidates = [packaged, new URL('../../templates/', import.meta.url), new URL('../../../templates/', import.meta.url), new URL('../../../../templates/', import.meta.url), new URL('../../../../../templates/', import.meta.url)];
  return candidates.find(candidate => existsSync(candidate)) ?? packaged;
}
