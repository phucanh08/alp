import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  AlpConfigRawSchema,
  type AlpConfigRaw,
  type AlpConfigRevision,
  type ProjectConfigRpcError,
} from "@alp/protocol/alp-config-schema";
export {
  AlpConfigRevisionSchema,
  ProjectConfigRpcErrorSchema,
  type AlpConfigRevision,
  type ProjectConfigRpcError,
} from "@alp/protocol/alp-config-schema";

export const ALP_CONFIG_FILE_NAME = "alp.json";

export type ReadAlpConfigForEditResult =
  | { ok: true; config: AlpConfigRaw | null; revision: AlpConfigRevision | null }
  | { ok: false; error: ProjectConfigRpcError };

export type WriteAlpConfigForEditResult =
  | { ok: true; config: AlpConfigRaw; revision: AlpConfigRevision }
  | { ok: false; error: ProjectConfigRpcError };

export interface WriteAlpConfigForEditInput {
  repoRoot: string;
  config: AlpConfigRaw;
  expectedRevision: AlpConfigRevision | null;
}

export function resolveAlpConfigPath(repoRoot: string): string {
  return join(repoRoot, ALP_CONFIG_FILE_NAME);
}

export function statAlpConfigPath(repoRoot: string): AlpConfigRevision | null {
  const configPath = resolveAlpConfigPath(repoRoot);
  if (!existsSync(configPath)) {
    return null;
  }
  const stats = statSync(configPath);
  return {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  };
}

export function readAlpConfigJson(repoRoot: string): unknown {
  const configPath = resolveAlpConfigPath(repoRoot);
  if (!existsSync(configPath)) {
    return null;
  }
  return JSON.parse(readFileSync(configPath, "utf8"));
}

export function readAlpConfigForEdit(repoRoot: string): ReadAlpConfigForEditResult {
  try {
    const json = readAlpConfigJson(repoRoot);
    if (json === null) {
      return { ok: true, config: null, revision: null };
    }
    return {
      ok: true,
      config: AlpConfigRawSchema.parse(json),
      revision: statAlpConfigPath(repoRoot),
    };
  } catch {
    return {
      ok: false,
      error: { code: "invalid_project_config" },
    };
  }
}

export function writeAlpConfigForEdit(
  input: WriteAlpConfigForEditInput,
): WriteAlpConfigForEditResult {
  const parsed = AlpConfigRawSchema.safeParse(input.config);
  if (!parsed.success) {
    return { ok: false, error: { code: "invalid_project_config" } };
  }

  const configPath = resolveAlpConfigPath(input.repoRoot);
  const tempPath = join(
    input.repoRoot,
    `.${ALP_CONFIG_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    writeFileSync(tempPath, `${JSON.stringify(parsed.data, null, 2)}\n`);
    const currentRevision = statAlpConfigPath(input.repoRoot);
    if (!alpConfigRevisionsEqual(currentRevision, input.expectedRevision)) {
      removeTempAlpConfig(tempPath);
      return {
        ok: false,
        error: { code: "stale_project_config", currentRevision },
      };
    }

    renameSync(tempPath, configPath);
    const revision = statAlpConfigPath(input.repoRoot);
    if (!revision) {
      return { ok: false, error: { code: "write_failed" } };
    }
    return { ok: true, config: parsed.data, revision };
  } catch {
    removeTempAlpConfig(tempPath);
    return { ok: false, error: { code: "write_failed" } };
  }
}

function alpConfigRevisionsEqual(
  left: AlpConfigRevision | null,
  right: AlpConfigRevision | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.mtimeMs === right.mtimeMs && left.size === right.size;
}

function removeTempAlpConfig(tempPath: string): void {
  try {
    rmSync(tempPath, { force: true });
  } catch {
    // Best-effort cleanup only; callers need the original write outcome.
  }
}
