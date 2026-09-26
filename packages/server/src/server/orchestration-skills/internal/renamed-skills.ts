import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentSkillSelection } from "@getpaseo/protocol/messages";

import { hashFile, MANAGED_FILES_MANIFEST, readManagedFilesManifest } from "./sync.js";

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

export const RENAMED_SKILL_OLD_NAMES: readonly string[] = [...RENAMED_SKILLS.keys()];

export interface SkillsLogger {
  warn(fields: Record<string, unknown>, message: string): void;
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
  for (const name of RENAMED_SKILL_OLD_NAMES) {
    if (shipped.has(name)) continue;
    for (const root of [roots.agentsDir, roots.claudeDir, roots.codexDir]) {
      const skillDir = path.join(root, name);
      try {
        const verdict = await inspectOldSkillDir(skillDir);
        if (verdict.kind === "absent") continue;
        if (verdict.kind === "keep") {
          logger.warn(
            { path: skillDir, reason: verdict.reason },
            "Kept a skill directory from before the alp rename",
          );
          continue;
        }
        await removeVerifiedDir(skillDir, verdict);
      } catch (error) {
        logger.warn(
          { path: skillDir, err: error },
          "Failed to remove a skill directory from before the alp rename",
        );
      }
    }
  }
}
