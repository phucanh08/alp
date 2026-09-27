// alp-rename-keep-file: this module reads the variable names alp 1.0.0 used.

// COMPAT(paseo-env): added after v1.0.0 on 2026-09-27; remove after 2027-03-27.
// The CLI copy of readAlpEnv in packages/server/src/server/rename-migration/legacy-names.ts:
// same rule, ALP_* wins and the 1.0.0 PASEO_* name is read when it is unset. Replace it with
// the server export once the CLI can take a new @alp/server symbol.
const CURRENT_PREFIX = "ALP_";
const LEGACY_PREFIX = "PASEO_";
const warned = new Set<string>();

export function readAlpEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = env[name];
  if (value !== undefined || !name.startsWith(CURRENT_PREFIX)) return value;
  const legacy = `${LEGACY_PREFIX}${name.slice(CURRENT_PREFIX.length)}`;
  const legacyValue = env[legacy];
  if (legacyValue !== undefined && !warned.has(legacy)) {
    warned.add(legacy);
    process.stderr.write(`alp: ${legacy} is from before the alp rename; rename it to ${name}\n`);
  }
  return legacyValue;
}
