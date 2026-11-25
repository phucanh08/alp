// @ts-check
// Shared by source checks and actual npm tarball inspection.
export const isPaseo = /** @param {string} name */ name => /^@getpaseo(?:\/|$)|^@anhlp\/alp-paseo(?:\/|$)/.test(name);
/**
 * @param {import('./release-lib.mjs').PackageJson} pkg
 * @param {string[]} [files]
 */
export function corePackageProblems(pkg, files = []) {
  const problems = [];
  for (const field of /** @type {('dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies')[]} */ (['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])) {
    for (const name of Object.keys(pkg[field] ?? {})) if (isPaseo(name)) problems.push(`${pkg.name}: forbidden Paseo dependency ${name} (${field})`);
  }
  for (const field of /** @type {('bundledDependencies' | 'bundleDependencies')[]} */ (['bundledDependencies', 'bundleDependencies'])) {
    // Array.isArray does not narrow pkg[field] for a non-literal key; the cast states what it checked.
    const names = Array.isArray(pkg[field]) ? /** @type {string[]} */ (pkg[field]) : pkg[field] === true ? Object.keys(pkg.dependencies ?? {}) : [];
    for (const name of names) if (isPaseo(name)) problems.push(`${pkg.name}: forbidden Paseo bundle ${name}`);
  }
  for (const file of [...(pkg.files ?? []), ...files]) {
    if (/(^|\/)integrations(?:\/|$)|@getpaseo\/|@anhlp\/alp-paseo/.test(file)) problems.push(`${pkg.name}: forbidden core artifact ${file}`);
  }
  return problems;
}
