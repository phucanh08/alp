// Shared by source checks and actual npm tarball inspection.
export const isPaseo = name => /^@getpaseo(?:\/|$)|^alp-paseo-plugin(?:\/|$)/.test(name);
export function corePackageProblems(pkg, files = []) {
  const problems = [];
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(pkg[field] ?? {})) if (isPaseo(name)) problems.push(`${pkg.name}: forbidden Paseo dependency ${name} (${field})`);
  }
  for (const field of ['bundledDependencies', 'bundleDependencies']) {
    const names = Array.isArray(pkg[field]) ? pkg[field] : pkg[field] === true ? Object.keys(pkg.dependencies ?? {}) : [];
    for (const name of names) if (isPaseo(name)) problems.push(`${pkg.name}: forbidden Paseo bundle ${name}`);
  }
  for (const file of [...(pkg.files ?? []), ...files]) {
    if (/(^|\/)(?:integrations|web-app)(?:\/|$)|@getpaseo\/|alp-paseo-plugin/.test(file)) problems.push(`${pkg.name}: forbidden core artifact ${file}`);
  }
  return problems;
}
