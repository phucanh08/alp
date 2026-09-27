import { withPreRenameEnvNames } from "./rename-migration/legacy-names.js";

const ALP_NODE_ENV = "ALP_NODE_ENV";
const ELECTRON_RUN_AS_NODE = "ELECTRON_RUN_AS_NODE";

const RUNTIME_CONTROL_ENV_KEYS = [
  ALP_NODE_ENV,
  "ALP_DESKTOP_MANAGED",
  "ALP_SUPERVISED",
  ELECTRON_RUN_AS_NODE,
  "ELECTRON_NO_ATTACH_CONSOLE",
  "ESBUILD_BINARY_PATH",
] as const;

export type AlpNodeEnv = "development" | "production" | "test";
export type ProcessEnvRecord = Record<string, string | undefined>;
export type ExternalProcessEnv = NodeJS.ProcessEnv & Record<string, string>;

function buildInternalProcessEnv<T extends ProcessEnvRecord>(baseEnv: T): T {
  return { ...baseEnv };
}

function buildExternalProcessEnv(
  baseEnv: ProcessEnvRecord,
  overlays: ProcessEnvRecord[],
): ExternalProcessEnv {
  const sanitized = Object.assign({}, baseEnv, ...overlays);
  for (const key of RUNTIME_CONTROL_ENV_KEYS) {
    delete sanitized[key];
  }
  for (const [key, value] of Object.entries(sanitized)) {
    if (value === undefined) {
      delete sanitized[key];
    }
  }
  return sanitized as ExternalProcessEnv;
}

export function createAlpInternalEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return buildInternalProcessEnv(baseEnv);
}

export function createExternalProcessEnv(
  baseEnv: ProcessEnvRecord,
  ...overlays: ProcessEnvRecord[]
): ExternalProcessEnv {
  return buildExternalProcessEnv(baseEnv, overlays);
}

export function createExternalCommandProcessEnv(
  _command: string,
  baseEnv: ProcessEnvRecord,
  ...overlays: ProcessEnvRecord[]
): ExternalProcessEnv {
  // Deprecated command parameter: retained while callers migrate to createExternalProcessEnv.
  return buildExternalProcessEnv(baseEnv, overlays);
}

export function buildSelfNodeCommand(
  args: string[],
  envOverlay?: ProcessEnvRecord,
): {
  command: string;
  args: string[];
  env: ExternalProcessEnv;
} {
  const env = buildExternalProcessEnv(process.env, []);
  Object.assign(env, { [ELECTRON_RUN_AS_NODE]: "1" }, envOverlay);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete env[key];
    }
  }
  return {
    command: process.execPath,
    args,
    env,
  };
}

export function resolveAlpNodeEnv(env: NodeJS.ProcessEnv): AlpNodeEnv | undefined {
  const value = env[ALP_NODE_ENV];
  return value === "development" || value === "production" || value === "test" ? value : undefined;
}

// A daemon started with only the 1.0.0 legacy home name resolves its home correctly but never
// tells its own process.env, so a child that reads ALP_HOME directly (the plugin host's fork()
// call passes no env override of its own) finds it unset.
// COMPAT(paseo-env): reuses the dual-export rule below. alp-rename-keep
/**
 * Publishes the daemon's resolved home into `env` under both names, so every process the daemon
 * forks or spawns sees `ALP_HOME` — including code that inherits `process.env` outright. Reuses
 * the dual-export rule in `withPreRenameEnvNames` (rename-migration/legacy-names.ts).
 */
export function applyResolvedAlpHomeEnv(
  alpHome: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  Object.assign(env, withPreRenameEnvNames({ ALP_HOME: alpHome }));
}
