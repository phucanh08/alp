import { z } from "zod";

const TCP_PORT_RANGE_PATTERN = /^(\d{1,5})-(\d{1,5})$/;

export const AlpServicePortAllocationSchema = z
  .object({
    range: z.string().trim().regex(TCP_PORT_RANGE_PATTERN).optional(),
    portScript: z.string().trim().min(1).optional(),
  })
  .strict()
  .refine(
    (value) => value.range !== undefined || value.portScript !== undefined,
    "Expected range or portScript",
  )
  .refine((value) => {
    if (!value.range) return true;
    const match = TCP_PORT_RANGE_PATTERN.exec(value.range);
    if (!match) return false;
    const start = Number(match[1]);
    const end = Number(match[2]);
    return start >= 1 && end <= 65_535 && start <= end;
  }, "Expected an inclusive TCP port range from 1-65535");

export function normalizeLifecycleCommands(commands: unknown): string[] {
  if (typeof commands === "string") {
    return commands.trim().length > 0 ? [commands] : [];
  }
  if (!Array.isArray(commands)) {
    return [];
  }
  return commands.filter((command): command is string => {
    return typeof command === "string" && command.trim().length > 0;
  });
}

export const AlpLifecycleCommandRawSchema = z.union([z.string(), z.array(z.string())]);

export const AlpScriptEntryRawSchema = z
  .object({
    type: z.unknown().optional(),
    command: z.unknown().optional(),
    port: z.unknown().optional(),
  })
  .passthrough();

export const AlpWorktreeConfigRawSchema = z
  .object({
    setup: AlpLifecycleCommandRawSchema.optional(),
    teardown: AlpLifecycleCommandRawSchema.optional(),
    terminals: z.unknown().optional(),
    servicePorts: AlpServicePortAllocationSchema.optional(),
  })
  .passthrough();

export const AlpMetadataGenerationEntrySchema = z
  .object({
    instructions: z.string().optional(),
  })
  .passthrough()
  .catch({});

export const AlpMetadataGenerationSchema = z
  .object({
    title: AlpMetadataGenerationEntrySchema.optional(),
    branchName: AlpMetadataGenerationEntrySchema.optional(),
    commitMessage: AlpMetadataGenerationEntrySchema.optional(),
    pullRequest: AlpMetadataGenerationEntrySchema.optional(),
  })
  // COMPAT(projectMetadataAgentTitle): `agentTitle` project metadata prompts were removed
  // in v0.1.96; keep legacy alp.json parseable until 2026-12-16.
  .passthrough()
  .catch({});

export const AlpConfigRawSchema = z
  .object({
    worktree: AlpWorktreeConfigRawSchema.optional(),
    scripts: z.record(z.string(), AlpScriptEntryRawSchema).optional(),
    metadataGeneration: AlpMetadataGenerationSchema.optional(),
  })
  .passthrough();

export const WorktreeConfigSchema = AlpWorktreeConfigRawSchema.extend({
  setup: z.unknown().optional().transform(normalizeLifecycleCommands),
  teardown: z.unknown().optional().transform(normalizeLifecycleCommands),
})
  .passthrough()
  .catch({ setup: [], teardown: [] });

export const ScriptEntrySchema = AlpScriptEntryRawSchema.catch({});

export const AlpConfigSchema = AlpConfigRawSchema.extend({
  worktree: WorktreeConfigSchema.optional(),
  scripts: z.record(z.string(), ScriptEntrySchema).optional().catch({}),
  metadataGeneration: AlpMetadataGenerationSchema.optional(),
})
  .passthrough()
  .catch({});

export const AlpConfigRevisionSchema = z.object({
  mtimeMs: z.number(),
  size: z.number(),
});

export const ProjectConfigRpcErrorSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("project_not_found") }),
  z.object({ code: z.literal("invalid_project_config") }),
  z.object({
    code: z.literal("stale_project_config"),
    currentRevision: AlpConfigRevisionSchema.nullable(),
  }),
  z.object({ code: z.literal("write_failed") }),
]);

export type AlpScriptEntryRaw = z.infer<typeof AlpScriptEntryRawSchema>;
export type AlpMetadataGenerationEntry = z.infer<typeof AlpMetadataGenerationEntrySchema>;
export type AlpMetadataGeneration = z.infer<typeof AlpMetadataGenerationSchema>;
export type AlpServicePortAllocation = z.infer<typeof AlpServicePortAllocationSchema>;
export type AlpConfigRaw = z.infer<typeof AlpConfigRawSchema>;
export type AlpConfig = z.infer<typeof AlpConfigSchema>;
export type AlpConfigRevision = z.infer<typeof AlpConfigRevisionSchema>;
export type ProjectConfigRpcError = z.infer<typeof ProjectConfigRpcErrorSchema>;
