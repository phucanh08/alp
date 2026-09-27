import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { PluginIdSchema, PluginRequirementsSchema } from "@alp/protocol/messages";
import { validatePluginRequirements } from "@alp/protocol/plugin-requirements";
import { reportLegacyNameUse } from "../rename-migration/legacy-names.js";

const MANIFEST_FILENAME = "alp-plugin.json";
// alp-rename-keep-start
// COMPAT(paseo-plugin-manifest): added after v1.0.0 on 2026-09-27; remove after 2027-03-27.
// A plugin written for alp 1.0.0 ships paseo-plugin.json with `requirements.paseo`. Plugins
// live in their authors' directories, so the old names are read, never rewritten.
const LEGACY_MANIFEST_FILENAME = "paseo-plugin.json";
const LEGACY_REQUIREMENTS_KEY = "paseo";
// alp-rename-keep-end
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
// The string form means "install: true"; the object form is the only other
// shape accepted, and only to say "install: false" — a bare { dir } or an
// explicit install: true object is rejected the way a bad string is.
const PluginSkillsConfigSchema = z.union([
  PluginSkillsDirectorySchema,
  z.object({ dir: PluginSkillsDirectorySchema, install: z.literal(false) }).strict(),
]);
const PluginManifestSchema = z
  .object({
    id: PluginIdSchema,
    description: z.string().trim().min(1).optional(),
    requirements: PluginRequirementsSchema.strict().optional(),
    build: z.array(PluginBuildCommandSchema).min(1).optional(),
    skills: PluginSkillsConfigSchema.optional(),
  })
  .strict();

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

async function isFile(filePath: string): Promise<boolean> {
  const info = await stat(filePath).catch(() => null);
  return info?.isFile() === true;
}

async function resolveManifestPath(directory: string): Promise<string> {
  const manifestPath = path.join(directory, MANIFEST_FILENAME);
  if (await isFile(manifestPath)) return manifestPath;
  const legacyPath = path.join(directory, LEGACY_MANIFEST_FILENAME);
  if (!(await isFile(legacyPath))) throw new Error(`Plugin manifest is missing: ${manifestPath}`);
  reportLegacyNameUse({
    kind: "plugin-manifest",
    legacy: LEGACY_MANIFEST_FILENAME,
    current: MANIFEST_FILENAME,
    path: legacyPath,
  });
  return legacyPath;
}

function renameLegacyRequirements(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || !("requirements" in raw)) return raw;
  const requirements = raw.requirements;
  if (typeof requirements !== "object" || requirements === null) return raw;
  if (!(LEGACY_REQUIREMENTS_KEY in requirements) || "alp" in requirements) return raw;
  const { [LEGACY_REQUIREMENTS_KEY]: range, ...rest } = requirements as Record<string, unknown>;
  return { ...raw, requirements: { ...rest, alp: range } };
}

export async function readPluginManifest(directory: string): Promise<PluginManifest> {
  const manifestPath = await resolveManifestPath(directory);
  const manifest = PluginManifestSchema.parse(
    renameLegacyRequirements(JSON.parse(await readFile(manifestPath, "utf8"))),
  );
  validatePluginRequirements(manifest.requirements);
  return manifest;
}

/** The plugin's skills directory, or null when the manifest declares none. */
export function resolvePluginSkillsDir(directory: string, manifest: PluginManifest): string | null {
  if (manifest.skills === undefined) return null;
  const dir = typeof manifest.skills === "string" ? manifest.skills : manifest.skills.dir;
  return path.resolve(directory, dir);
}

/**
 * Whether the plugin's skills should ever land in an agent home. `false` only
 * for the `{ dir, install: false }` form — the names still count as shipped
 * and managed (see readSkillCatalog's `enabled` source flag), so an existing
 * copy is still offered for cleanup, but nothing installs it.
 */
export function pluginSkillsInstallable(manifest: PluginManifest): boolean {
  return typeof manifest.skills !== "object";
}
