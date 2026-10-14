import { existsSync } from 'node:fs';

/** Source packages carry templates beside src; legacy bundles live one directory deeper. */
export function shippedTemplateRoot() {
  const packaged = new URL('../templates/', import.meta.url);
  const candidates = [packaged, new URL('../../templates/', import.meta.url), new URL('../../../templates/', import.meta.url)];
  return candidates.find(candidate => existsSync(candidate)) ?? packaged;
}
