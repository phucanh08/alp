import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentSkillSelection } from "@getpaseo/protocol/messages";
import { removeRenamedSkillDirs, type SkillsLogger } from "./renamed-skills.js";
import { listFilesRecursive, removeSkill, syncSkills } from "./sync.js";

export type SkillsState = "not-installed" | "up-to-date" | "drift";

export type SkillOp =
  | { kind: "add"; name: string }
  | { kind: "update"; name: string }
  | { kind: "delete"; name: string };

/** What the user asked to have installed. `all` follows the bundle as it grows. */
export type SkillSelection = AgentSkillSelection;

export interface SkillsStatus {
  state: SkillsState;
  ops: SkillOp[];
  /** Every skill the bundle currently ships, sorted. The selectable catalog. */
  available: string[];
  /**
   * Managed skills with a directory in at least one agent home, sorted. An `add`
   * op means "missing from at least one target", so it cannot answer whether
   * there is anything on disk to delete — this can.
   */
  installed: string[];
}

export interface SkillsMaintenanceOptions {
  logger: SkillsLogger;
}

export interface SkillTargets {
  sourceDir: string;
  agentsDir: string;
  claudeDir: string;
  codexDir: string;
  /** Skills shipped by plugins, beside the core bundle in `sourceDir`. */
  pluginSources?: readonly PluginSkillSource[];
}

export interface PluginSkillSource {
  pluginId: string;
  /** Holds one directory per skill, like `sourceDir`. */
  dir: string;
  /** Only an enabled source's skills are selectable; every source's names stay managed. */
  enabled: boolean;
}

export interface SkillCatalog {
  /** Skills that can be installed now: the core bundle plus enabled plugins, sorted. */
  available: string[];
  /** Every name a known source ships, enabled or not, sorted. */
  shipped: string[];
  /** The source directory holding each shipped skill. */
  sourceDirs: Map<string, string>;
}

// Names the bundle used to ship. They are never selectable, but every scan still
// covers them so an older install's copies get cleaned up. Names renamed to alp*,
// and names retired with nothing replacing them, are not here: only
// `removeRenamedSkillDirs` may remove those.
// alp-rename-keep-start: names older releases installed on disk.
export const LEGACY_SKILL_NAMES: readonly string[] = [
  "paseo-chat",
  "paseo-epic",
  "paseo-orchestrate",
  "paseo-orchestrator",
];
// alp-rename-keep-end

type SkillFiles = Map<string, string>;
type TargetSkills = Map<string, SkillFiles>;

/**
 * The bundle directory is the catalog. Reading it instead of a hardcoded list is
 * what makes `all` pick up skills added in a later release with no code change.
 */
async function listBundledSkills(sourceDir: string): Promise<string[]> {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareStrings);
}

const CORE_OWNER = "the core skills bundle";

const NOOP_LOGGER: SkillsLogger = { warn: () => {}, error: () => {} };

/**
 * Two sources shipping one name is a collision rather than a shadow: whichever
 * copy won would silently replace the other in every agent home. Copies from
 * the same plugin (a config entry replacing the bundled one) are one source.
 *
 * The core bundle always owns its names: a plugin that ships one does not get
 * it, and core is unaffected. Two plugins sharing a name both lose it — it is
 * shipped (so a copy already on disk stays deletable from Settings) but never
 * available. Either way the collision is only logged, never thrown, so one bad
 * plugin manifest cannot block status, install, or cleanup for anything else.
 */
export async function readSkillCatalog(
  targets: SkillTargets,
  logger: SkillsLogger = NOOP_LOGGER,
): Promise<SkillCatalog> {
  const sources = [
    { owner: CORE_OWNER, dir: targets.sourceDir, enabled: true },
    ...(targets.pluginSources ?? []).map((source) => ({
      owner: `plugin "${source.pluginId}"`,
      dir: source.dir,
      enabled: source.enabled,
    })),
  ];
  const owners = new Map<string, string>();
  const sourceDirs = new Map<string, string>();
  const available = new Set<string>();
  // Enabled first, so a skill's content comes from the copy that is running.
  for (const source of [
    ...sources.filter((s) => s.enabled),
    ...sources.filter((s) => !s.enabled),
  ]) {
    for (const name of await listBundledSkills(source.dir)) {
      const owner = owners.get(name);
      if (owner !== undefined && owner !== source.owner) {
        logger.error(
          { skill: name, owners: [owner, source.owner] },
          `Skill "${name}" is shipped by both ${owner} and ${source.owner}`,
        );
        // Core keeps the name and behaves as if the plugin were absent. Between
        // two plugins, the name is contested and neither copy is available.
        if (owner !== CORE_OWNER) available.delete(name);
        continue;
      }
      owners.set(name, source.owner);
      if (!sourceDirs.has(name)) sourceDirs.set(name, source.dir);
      if (source.enabled) available.add(name);
    }
  }
  return {
    available: [...available].sort(compareStrings),
    shipped: [...owners.keys()].sort(compareStrings),
    sourceDirs,
  };
}

/** Every name Paseo owns on disk: what it ships now plus what it used to ship. */
function managedSkillNames(shipped: readonly string[]): string[] {
  return [...new Set([...shipped, ...LEGACY_SKILL_NAMES])].sort(compareStrings);
}

/** The names a convergence may create, replace, or delete. */
export async function listManagedSkillNames(
  targets: SkillTargets,
  logger: SkillsLogger = NOOP_LOGGER,
): Promise<string[]> {
  return managedSkillNames((await readSkillCatalog(targets, logger)).shipped);
}

function resolveDesiredSkills(
  selection: SkillSelection,
  available: readonly string[],
): Set<string> {
  if (selection.mode === "all") return new Set(available);
  const chosen = new Set(selection.skills);
  return new Set(available.filter((name) => chosen.has(name)));
}

async function hashSkillDir(skillDir: string): Promise<SkillFiles | null> {
  const stat = await fs.stat(skillDir).catch(() => null);
  if (!stat?.isDirectory()) return null;

  const rels = await listFilesRecursive(skillDir);
  const files: SkillFiles = new Map();
  for (const rel of rels) {
    const buf = await fs.readFile(path.join(skillDir, rel));
    const sha = createHash("sha256").update(buf).digest("hex");
    files.set(toPosix(rel), sha);
  }
  return files;
}

async function hashSkills(
  rootDirOf: (name: string) => string,
  names: readonly string[],
): Promise<TargetSkills> {
  const out: TargetSkills = new Map();
  for (const name of names) {
    const files = await hashSkillDir(path.join(rootDirOf(name), name));
    if (files !== null) out.set(name, files);
  }
  return out;
}

function diff(
  bundle: TargetSkills,
  disks: readonly TargetSkills[],
  names: readonly string[],
  desired: ReadonlySet<string>,
): SkillOp[] {
  const ops: SkillOp[] = [];
  for (const name of names) {
    const b = desired.has(name) ? bundle.get(name) : undefined;
    const targetFiles = disks.map((disk) => disk.get(name));
    const installedTargets = targetFiles.filter(
      (files): files is SkillFiles => files !== undefined,
    );
    if (b) {
      const missingTargets = installedTargets.length < disks.length;
      const changedTargets = installedTargets.some((files) => !bundleFilesMatch(b, files));
      if (missingTargets) ops.push({ kind: "add", name });
      else if (changedTargets) ops.push({ kind: "update", name });
    } else if (installedTargets.length > 0) {
      ops.push({ kind: "delete", name });
    }
  }
  ops.sort((a, b) => compareStrings(a.name, b.name));
  return ops;
}

function hasInstalledPaseoSkill(disks: readonly TargetSkills[]): boolean {
  return disks.some((disk) => disk.size > 0);
}

function installedSkillNames(disks: readonly TargetSkills[], names: readonly string[]): string[] {
  return names.filter((name) => disks.some((disk) => disk.has(name)));
}

function bundleFilesMatch(bundle: SkillFiles, disk: SkillFiles): boolean {
  for (const [rel, sha] of bundle) {
    if (disk.get(rel) !== sha) return false;
  }
  return true;
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export async function getSkillsStatus(
  targets: SkillTargets,
  selection: SkillSelection,
  options?: SkillsMaintenanceOptions,
): Promise<SkillsStatus> {
  const catalog = await readSkillCatalog(targets, options?.logger);
  const { available } = catalog;
  const names = managedSkillNames(catalog.shipped);
  const [bundle, agentsDisk, claudeDisk, codexDisk] = await Promise.all([
    hashSkills((name) => catalog.sourceDirs.get(name)!, available),
    hashSkills(() => targets.agentsDir, names),
    hashSkills(() => targets.claudeDir, names),
    hashSkills(() => targets.codexDir, names),
  ]);
  const disks = [agentsDisk, claudeDisk, codexDisk];
  const ops = diff(bundle, disks, names, resolveDesiredSkills(selection, available));
  const installed = installedSkillNames(disks, names);

  if (!hasInstalledPaseoSkill(disks)) return { state: "not-installed", ops, available, installed };
  if (ops.length === 0) return { state: "up-to-date", ops, available, installed };
  return { state: "drift", ops, available, installed };
}

async function applySkills(
  targets: SkillTargets,
  selection: SkillSelection,
  initialStatus?: SkillsStatus,
  logger: SkillsLogger = NOOP_LOGGER,
): Promise<SkillsStatus> {
  const status = initialStatus ?? (await getSkillsStatus(targets, selection, { logger }));

  const writes = status.ops
    .filter((op) => op.kind === "add" || op.kind === "update")
    .map((op) => op.name);
  if (writes.length > 0) {
    const { sourceDirs } = await readSkillCatalog(targets, logger);
    const bySource = new Map<string, string[]>();
    for (const name of writes) {
      const sourceDir = sourceDirs.get(name);
      if (sourceDir === undefined) continue;
      bySource.set(sourceDir, [...(bySource.get(sourceDir) ?? []), name]);
    }
    for (const [sourceDir, skillNames] of bySource) {
      await syncSkills({
        sourceDir,
        agentsDir: targets.agentsDir,
        claudeDir: targets.claudeDir,
        codexDir: targets.codexDir,
        skillNames,
      });
    }
  }

  for (const op of status.ops) {
    if (op.kind !== "delete") continue;
    await removeSkill(op.name, {
      agentsDir: targets.agentsDir,
      claudeDir: targets.claudeDir,
      codexDir: targets.codexDir,
    });
  }

  return getSkillsStatus(targets, selection, { logger });
}

export async function installSkills(
  targets: SkillTargets,
  selection: SkillSelection,
  /** Apply exactly this plan instead of rescanning, so a confirmed plan is the applied plan. */
  plan?: SkillsStatus,
  options?: SkillsMaintenanceOptions,
): Promise<SkillsStatus> {
  return applySkills(targets, selection, plan, options?.logger);
}

export async function updateSkills(
  targets: SkillTargets,
  selection: SkillSelection,
  options: SkillsMaintenanceOptions,
): Promise<SkillsStatus> {
  await removeRenamedSkillDirs(
    targets,
    (await readSkillCatalog(targets, options.logger)).shipped,
    options.logger,
  );
  const status = await getSkillsStatus(targets, selection, options);
  return applySkills(targets, selection, nonDestructivePlan(status), options.logger);
}

function nonDestructivePlan(status: SkillsStatus): SkillsStatus {
  return { ...status, ops: status.ops.filter((op) => op.kind !== "delete") };
}

export async function autoUpdateInstalledSkills(
  targets: SkillTargets,
  selection: SkillSelection,
  options: SkillsMaintenanceOptions,
): Promise<SkillsStatus> {
  // Old and retired directories are invisible to status, so this runs even when
  // the managed skills are already up to date.
  await removeRenamedSkillDirs(
    targets,
    (await readSkillCatalog(targets, options.logger)).shipped,
    options.logger,
  );
  const status = await getSkillsStatus(targets, selection, options);
  // ALP(slp): a bare host reads as not-installed exactly like one where the
  // user explicitly uninstalled everything — treat it the same as drift so a
  // selection set before any skill exists on disk installs at startup instead
  // of waiting for someone to open Settings and press Install.
  if (status.state !== "drift" && status.state !== "not-installed") return status;
  // Automatic maintenance may repair selected skills, but removal is an
  // interactive operation because managed directories can contain user files.
  // Renamed and retired skills are the exception: their copies are removed
  // above only when every file in them is still the one the old bundle
  // installed.
  return applySkills(targets, selection, nonDestructivePlan(status), options.logger);
}

export async function uninstallSkills(
  targets: SkillTargets,
  selection: SkillSelection,
  options?: SkillsMaintenanceOptions,
): Promise<SkillsStatus> {
  for (const name of await listManagedSkillNames(targets, options?.logger)) {
    await removeSkill(name, {
      agentsDir: targets.agentsDir,
      claudeDir: targets.claudeDir,
      codexDir: targets.codexDir,
    });
  }
  return getSkillsStatus(targets, selection, options);
}
