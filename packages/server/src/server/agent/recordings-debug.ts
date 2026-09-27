import { resolve } from "path";
import { readAlpEnv } from "../rename-migration/legacy-names.js";

function isTruthyEnv(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function isAlpDictationDebugEnabled(): boolean {
  return isTruthyEnv(readAlpEnv(process.env, "ALP_DICTATION_DEBUG"));
}

export function resolveRecordingsDebugDir(explicitEnvVarName: string): string | null {
  const explicit = process.env[explicitEnvVarName];
  if (explicit && explicit.trim()) {
    return resolve(explicit.trim());
  }

  if (!isAlpDictationDebugEnabled()) {
    return null;
  }

  return resolve(process.cwd(), ".debug/recordings");
}
