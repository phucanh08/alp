import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PluginIdSchema, PluginRequirementsSchema } from "@getpaseo/protocol/messages";
import { validatePluginRequirements } from "@getpaseo/protocol/plugin-requirements";

const MANIFEST_FILENAME = "paseo-plugin.json";
const PluginBuildCommandSchema = z
  .array(z.string().refine((argument) => argument.trim().length > 0))
  .min(1);
// A directory inside the plugin whose subdirectories are agent skills.
const PluginSkillsDirectorySchema = z.string().refine((value) => {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  return (
    value.length > 0 &&
    value === value.trim() &&
    !path.posix.isAbsolute(normalized) &&
    !path.win32.isAbsolute(value) &&
    // path.win32.isAbsolute treats "D:skills" as not absolute (drive-relative,
    // no separator after the colon), but win32.resolve still resolves it
    // against drive D's own cwd rather than the plugin directory. Reject any
    // drive-letter prefix outright instead of relying on isAbsolute for it.
    !/^[a-zA-Z]:/.test(value) &&
    normalized !== "." &&
    normalized !== "./" &&
    normalized !== ".." &&
    !normalized.startsWith("../")
  );
}, "skills must name a directory inside the plugin");
const PluginManifestSchema = z
  .object({
    id: PluginIdSchema,
    description: z.string().trim().min(1).optional(),
    requirements: PluginRequirementsSchema.strict().optional(),
    build: z.array(PluginBuildCommandSchema).min(1).optional(),
    skills: PluginSkillsDirectorySchema.optional(),
  })
  .strict();

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

export async function readPluginManifest(directory: string): Promise<PluginManifest> {
  const manifestPath = path.join(directory, MANIFEST_FILENAME);
  const info = await stat(manifestPath).catch(() => null);
  if (!info?.isFile()) throw new Error(`Plugin manifest is missing: ${manifestPath}`);
  const manifest = PluginManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  validatePluginRequirements(manifest.requirements);
  return manifest;
}

/** The plugin's skills directory, or null when the manifest declares none. */
export function resolvePluginSkillsDir(directory: string, manifest: PluginManifest): string | null {
  return manifest.skills === undefined ? null : path.resolve(directory, manifest.skills);
}
