import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentSkillSelection } from "@getpaseo/protocol/messages";

import { hashFile, MANAGED_FILES_MANIFEST, readManagedFilesManifest } from "./sync.js";

// alp-rename-keep-start: the old skill names are what this migration reads.
// ALP(rebrand): the bundle's paseo* skills ship as alp*. Old names map to the
// new ones so saved selections keep meaning the same skills, and installed
// copies under an old name are removed once nothing in them is the user's.
// Only `removeRenamedSkillDirs` deletes them: they are not managed names, so
// status, uninstall, and save never plan, report, or delete an old directory.
const RENAMED_SKILLS: ReadonlyMap<string, string> = new Map([
  ["paseo", "alp"],
  ["paseo-advisor", "alp-advisor"],
  ["paseo-committee", "alp-committee"],
  ["paseo-handoff", "alp-handoff"],
  ["paseo-help", "alp-help"],
  ["paseo-plugin", "alp-plugin"],
]);
// alp-rename-keep-end

export const RENAMED_SKILL_OLD_NAMES: readonly string[] = [...RENAMED_SKILLS.keys()];

// ALP(p21): a skill the bundle stops shipping, with nothing replacing it — as
// opposed to a rename, which has a new name to install instead. `ask-alp` is
// retired: seats read plugins/slp-dev/references/seats.md directly now. Like a
// renamed old name, a retired name is never managed: status, uninstall, and
// save never plan, report, or delete it. Only `removeRenamedSkillDirs` cleans
// up a leftover copy, with the same safety rule as a renamed directory.
export const RETIRED_SKILL_NAMES: readonly string[] = ["ask-alp"];

export interface SkillsLogger {
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface RenamedSkillRoots {
  agentsDir: string;
  claudeDir: string;
  codexDir: string;
}

/** Replaces old names with their new ones, deduped and sorted like `coerceSkillNames`. */
export function renameSkillNames(names: readonly string[]): string[] {
  return [...new Set(names.map((name) => RENAMED_SKILLS.get(name) ?? name))].sort();
}

/** Every selection entering the skills code goes through this, so old names never reach a plan. */
export function renameSkillSelection(selection: AgentSkillSelection): AgentSkillSelection {
  if (selection.mode === "all") return selection;
  return { mode: "custom", skills: renameSkillNames(selection.skills) };
}

type Verdict =
  | { kind: "absent" }
  | { kind: "keep"; reason: string }
  | { kind: "remove"; files: string[]; dirs: string[] };

/**
 * A directory is removable only if every entry in it is explained by its
 * manifest: each file is listed with the hash it was installed with, and each
 * subdirectory holds such a file. Anything else may be the user's.
 */
async function inspectOldSkillDir(skillDir: string): Promise<Verdict> {
  const info = await fs.lstat(skillDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (info === null) return { kind: "absent" };
  if (info.isSymbolicLink()) return { kind: "keep", reason: "the directory is a symlink" };
  if (!info.isDirectory()) return { kind: "keep", reason: "not a directory" };

  const files: string[] = [];
  const dirs: string[] = [];
  const pending = [""];
  while (pending.length > 0) {
    const rel = pending.pop()!;
    for (const entry of await fs.readdir(path.join(skillDir, rel), { withFileTypes: true })) {
      const entryRel = path.join(rel, entry.name);
      if (entry.isSymbolicLink()) return { kind: "keep", reason: `symlink ${entryRel}` };
      if (entry.isDirectory()) {
        dirs.push(entryRel);
        pending.push(entryRel);
      } else if (entry.isFile()) {
        files.push(entryRel);
      } else {
        return { kind: "keep", reason: `unexpected entry ${entryRel}` };
      }
    }
  }

  const manifest = await readManagedFilesManifest(skillDir);
  if (manifest === null) return { kind: "keep", reason: `no readable ${MANAGED_FILES_MANIFEST}` };

  const managedFiles = files.filter((rel) => rel !== MANAGED_FILES_MANIFEST);
  for (const rel of managedFiles) {
    if (!Object.hasOwn(manifest.files, rel)) {
      return { kind: "keep", reason: `file not in manifest ${rel}` };
    }
    if ((await hashFile(path.join(skillDir, rel))) !== manifest.files[rel]) {
      return { kind: "keep", reason: `file changed since install ${rel}` };
    }
  }
  for (const dir of dirs) {
    if (!managedFiles.some((rel) => rel.startsWith(`${dir}${path.sep}`))) {
      return { kind: "keep", reason: `directory not in manifest ${dir}` };
    }
  }
  return { kind: "remove", files: managedFiles, dirs };
}

/**
 * Unlinks only the verified files and removes directories without recursion,
 * so a file created after inspection makes removal stop instead of deleting it.
 * The manifest goes last: an interrupted removal stays removable next run.
 */
async function removeVerifiedDir(
  skillDir: string,
  verdict: Extract<Verdict, { kind: "remove" }>,
): Promise<void> {
  for (const rel of verdict.files) {
    await fs.unlink(path.join(skillDir, rel));
  }
  const deepestFirst = [...verdict.dirs].sort(
    (a, b) => b.split(path.sep).length - a.split(path.sep).length,
  );
  for (const rel of deepestFirst) {
    await fs.rmdir(path.join(skillDir, rel));
  }
  await fs.unlink(path.join(skillDir, MANAGED_FILES_MANIFEST));
  await fs.rmdir(skillDir);
}

interface StaleSkillGroup {
  names: readonly string[];
  keptMessage: string;
  failedMessage: string;
}

// One group per reason a name stopped being managed. Same inspection and
// removal for both: only the log wording tells them apart.
const STALE_SKILL_GROUPS: readonly StaleSkillGroup[] = [
  {
    names: RENAMED_SKILL_OLD_NAMES,
    keptMessage: "Kept a skill directory from before the alp rename",
    failedMessage: "Failed to remove a skill directory from before the alp rename",
  },
  {
    names: RETIRED_SKILL_NAMES,
    keptMessage: "Kept a retired skill's directory",
    failedMessage: "Failed to remove a retired skill's directory",
  },
];

async function removeStaleSkillDir(
  skillDir: string,
  group: StaleSkillGroup,
  logger: SkillsLogger,
): Promise<void> {
  try {
    const verdict = await inspectOldSkillDir(skillDir);
    if (verdict.kind === "absent") return;
    if (verdict.kind === "keep") {
      logger.warn({ path: skillDir, reason: verdict.reason }, group.keptMessage);
      return;
    }
    await removeVerifiedDir(skillDir, verdict);
  } catch (error) {
    logger.warn({ path: skillDir, err: error }, group.failedMessage);
  }
}

/**
 * Runs from automatic maintenance, which never deletes anything else. Failures
 * are logged and skipped so they cannot stop the renamed skills installing.
 */
export async function removeRenamedSkillDirs(
  roots: RenamedSkillRoots,
  shippedNames: readonly string[],
  logger: SkillsLogger,
): Promise<void> {
  const shipped = new Set(shippedNames);
  for (const group of STALE_SKILL_GROUPS) {
    for (const name of group.names) {
      if (shipped.has(name)) continue;
      for (const root of [roots.agentsDir, roots.claudeDir, roots.codexDir]) {
        await removeStaleSkillDir(path.join(root, name), group, logger);
      }
    }
  }
}
