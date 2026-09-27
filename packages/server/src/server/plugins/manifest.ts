import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  PluginIdSchema,
  PluginRequirementsSchema,
  type PluginRequirements,
} from "@alp/protocol/messages";
import {
  assertPluginCompatibility,
  validatePluginRequirements,
} from "@alp/protocol/plugin-requirements";
import validRange from "semver/ranges/valid.js";

const MANIFEST_FILENAME = "alp-plugin.json";
// alp-rename-keep-start
// COMPAT(paseo-plugin-manifest): added in v1.0.0, remove after 2027-03-27 once plugins written
// for upstream Paseo ship alp-plugin.json. Only this file may carry requirements.paseo.
const UPSTREAM_MANIFEST_FILENAME = "paseo-plugin.json";
// The upstream Paseo release this alp is built on; requirements.paseo is checked against it.
// Bump it whenever scripts/sync-upstream.mjs merges a newer upstream release.
export const UPSTREAM_BASE_VERSION = "0.9.2";
// The first alp release built on UPSTREAM_BASE_VERSION. The app only checks requirements.alp, so a
// legacy plugin whose requirements.paseo passed is published to it with this range.
const UPSTREAM_BASE_ALP_RANGE = ">=1.0.0";
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

// alp-rename-keep-start
const UpstreamPluginManifestSchema = PluginManifestSchema.extend({
  requirements: PluginRequirementsSchema.extend({ paseo: z.string().optional() })
    .strict()
    .optional(),
}).strict();

export type PluginManifest = z.infer<typeof PluginManifestSchema> & {
  /** COMPAT(paseo-plugin-manifest): requirements.paseo from a paseo-plugin.json. */
  paseoRequirement?: string;
};
// alp-rename-keep-end

export async function readPluginManifest(directory: string): Promise<PluginManifest> {
  const { manifestPath, upstream } = await resolveManifestPath(directory);
  const raw: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
  const manifest = upstream ? parseUpstreamManifest(raw) : PluginManifestSchema.parse(raw);
  validatePluginRequirements(manifest.requirements);
  return manifest;
}

// alp-rename-keep-start
function parseUpstreamManifest(raw: unknown): PluginManifest {
  const { requirements, ...manifest } = UpstreamPluginManifestSchema.parse(raw);
  if (!requirements) return manifest;
  const { paseo, ...alpRequirements } = requirements;
  if (paseo !== undefined && (!paseo.trim() || validRange(paseo) === null)) {
    throw new Error(
      `Invalid requirements.paseo in paseo-plugin.json: ${JSON.stringify(paseo)}. Use an npm semver range such as ">=0.9.0".`,
    );
  }
  return {
    ...manifest,
    ...(Object.keys(alpRequirements).length > 0 ? { requirements: alpRequirements } : {}),
    ...(paseo !== undefined ? { paseoRequirement: paseo } : {}),
  };
}
// alp-rename-keep-end

// alp-rename-keep-start
/**
 * Throws when this daemon cannot run the plugin. A requirements.paseo range from a
 * paseo-plugin.json is checked against UPSTREAM_BASE_VERSION instead of the alp version.
 */
export function assertPluginManifestCompatibility(
  manifest: PluginManifest,
  daemonVersion: string | null,
): void {
  const range = manifest.paseoRequirement;
  if (range === undefined || manifest.requirements?.alp !== undefined) {
    assertPluginCompatibility({ ...manifest, version: daemonVersion, runtime: "daemon" });
  }
  if (range === undefined) return;
  try {
    assertPluginCompatibility({
      id: manifest.id,
      requirements: { alp: range },
      version: UPSTREAM_BASE_VERSION,
      runtime: "daemon",
    });
  } catch (error) {
    throw new Error(
      `Plugin "${manifest.id}" requires Paseo ${range} (requirements.paseo in paseo-plugin.json), but this alp is built on Paseo ${UPSTREAM_BASE_VERSION}. Use a plugin version that supports it.`,
      { cause: error },
    );
  }
}

/**
 * The requirements the app checks for this plugin. The wire carries only requirements.alp, so a
 * legacy requirements.paseo (already checked by assertPluginManifestCompatibility) becomes
 * UPSTREAM_BASE_ALP_RANGE.
 */
export function pluginCatalogRequirements(
  manifest: PluginManifest,
): PluginRequirements | undefined {
  if (manifest.requirements?.alp !== undefined || manifest.paseoRequirement === undefined) {
    return manifest.requirements;
  }
  return { ...manifest.requirements, alp: UPSTREAM_BASE_ALP_RANGE };
}
// alp-rename-keep-end

async function resolveManifestPath(
  directory: string,
): Promise<{ manifestPath: string; upstream: boolean }> {
  const manifestPath = path.join(directory, MANIFEST_FILENAME);
  if (await isFile(manifestPath)) return { manifestPath, upstream: false };
  const upstreamManifestPath = path.join(directory, UPSTREAM_MANIFEST_FILENAME);
  if (await isFile(upstreamManifestPath)) {
    return { manifestPath: upstreamManifestPath, upstream: true };
  }
  throw new Error(`Plugin manifest is missing: ${manifestPath}`);
}

async function isFile(filePath: string): Promise<boolean> {
  const info = await stat(filePath).catch(() => null);
  return info?.isFile() === true;
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
