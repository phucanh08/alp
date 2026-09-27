// alp-rename-keep-file: this module reads the names alp used before the paseo → alp rename.

/**
 * A pre-rename name alp still honored: an environment variable, a repo config file, or a
 * plugin manifest. Each one is reported once per process so the user learns what to rename.
 */
export interface LegacyNameUse {
  kind: "env" | "repo-config" | "plugin-manifest";
  legacy: string;
  current: string;
  path?: string;
}

type LegacyNameReporter = (use: LegacyNameUse) => void;

const reported = new Set<string>();
let pending: LegacyNameUse[] = [];
let reporter: LegacyNameReporter | null = null;

/**
 * Reads happen before the daemon has a logger (home resolution, config load), so uses are
 * queued until `setLegacyNameReporter` names where they go.
 */
export function reportLegacyNameUse(use: LegacyNameUse): void {
  const key = `${use.kind}\0${use.legacy}\0${use.path ?? ""}`;
  if (reported.has(key)) return;
  reported.add(key);
  if (reporter) reporter(use);
  else pending.push(use);
}

export function setLegacyNameReporter(next: LegacyNameReporter): void {
  reporter = next;
  const queued = pending;
  pending = [];
  for (const use of queued) next(use);
}

// COMPAT(paseo-env): added after v1.0.0 on 2026-09-27; remove after 2027-03-27.
// alp 1.0.0 read PASEO_* variables. A user's shell profile, service unit, or container spec
// that still sets them keeps working: the ALP_* name wins when both are set.
const CURRENT_PREFIX = "ALP_";
const LEGACY_PREFIX = "PASEO_";

export function legacyEnvName(name: string): string | null {
  return name.startsWith(CURRENT_PREFIX)
    ? `${LEGACY_PREFIX}${name.slice(CURRENT_PREFIX.length)}`
    : null;
}

/** `env[name]`, or the pre-rename variable's value when only that one is set. */
export function readAlpEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const value = env[name];
  if (value !== undefined) return value;
  const legacy = legacyEnvName(name);
  if (legacy === null) return undefined;
  const legacyValue = env[legacy];
  if (legacyValue !== undefined) reportLegacyNameUse({ kind: "env", legacy, current: name });
  return legacyValue;
}

/**
 * `env` plus each ALP_* variable under its 1.0.0 PASEO_* name, with the same value. Applied to
 * what the daemon writes into a child — repo scripts, service scripts, terminals, agents — so a
 * script, hook command, or tool written for 1.0.0 still finds its variables.
 */
export function withPreRenameEnvNames<Env extends Record<string, string>>(env: Env): Env {
  const next: Record<string, string> = { ...env };
  for (const [name, value] of Object.entries(env)) {
    const legacy = legacyEnvName(name);
    if (legacy !== null) next[legacy] = value;
  }
  return next as Env;
}
