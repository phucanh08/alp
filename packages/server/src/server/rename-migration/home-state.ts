// alp-rename-keep-file: this module reads what alp 1.0.0 wrote under its pre-rename names.
import {
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

// COMPAT(paseo-home-state): added after v1.0.0 on 2026-09-27; remove after 2027-03-27.
// alp 1.0.0 wrote its state under the paseo names. The renamed build reads only the alp names,
// so the daemon moves that state over once, at start, before anything reads it. Every step is
// a rename or a verified rewrite, never a delete, and a step that finds its target already in
// place does nothing, so running this on every start is safe. The lock file moves at acquire
// (pid-lock.ts); env vars and repo config are read under both names (legacy-names.ts).

const LEGACY_MANAGED_FILES = ".paseo-managed-files.json";
const MANAGED_FILES = ".alp-managed-files.json";
const LEGACY_TRANSACTION_PREFIX = ".paseo-skills-transaction-";
const TRANSACTION_PREFIX = ".alp-skills-transaction-";
const LEGACY_TRANSACTION_OWNER = "paseo-skills-transaction";
const TRANSACTION_OWNER = "alp-skills-transaction";
const LEGACY_LABEL_PREFIX = "paseo.";
const LABEL_PREFIX = "alp.";
const LEGACY_WORKTREE_METADATA_DIR = "paseo";
const WORKTREE_METADATA_DIR = "alp";

export interface PreRenameMigrationStep {
  path: string;
  to?: string;
  reason?: string;
}

export interface PreRenameMigrationReport {
  changed: PreRenameMigrationStep[];
  skipped: PreRenameMigrationStep[];
}

interface MigrationLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

type JsonObject = Record<string, unknown>;
type Note = (reason: string) => void;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDirectory(target: string): boolean {
  try {
    const info = lstatSync(target);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

function listDirectory(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * Moves `from` to `to` unless `to` already exists. Files move by link then unlink, which fails
 * rather than overwrites when `to` appears in between.
 */
function moveUnlessTaken(from: string, to: string, report: PreRenameMigrationReport): void {
  if (!existsSync(from)) return;
  if (existsSync(to)) {
    report.skipped.push({ path: from, reason: `${path.basename(to)} already exists` });
    return;
  }
  try {
    if (lstatSync(from).isDirectory()) {
      renameSync(from, to);
    } else {
      linkSync(from, to);
      unlinkSync(from);
    }
    report.changed.push({ path: from, to });
  } catch (error) {
    report.skipped.push({ path: from, reason: describeError(error) });
  }
}

/**
 * Rewrites a JSON file in place when `transform` returns a new value. The new text goes to a
 * temporary file with the original's mode, is read back and compared, and only then replaces
 * the original; a file that cannot be parsed or verified stays exactly as it was.
 */
function rewriteJson(
  filePath: string,
  mentionsLegacyName: (raw: string) => boolean,
  transform: (value: unknown, note: Note) => unknown,
  report: PreRenameMigrationReport,
): void {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  if (!mentionsLegacyName(raw)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    report.skipped.push({ path: filePath, reason: `not valid JSON: ${describeError(error)}` });
    return;
  }
  const next = transform(parsed, (reason) => report.skipped.push({ path: filePath, reason }));
  if (next === parsed) return;

  const text = `${JSON.stringify(next, null, 2)}${raw.endsWith("\n") ? "\n" : ""}`;
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, text, { mode: statSync(filePath).mode & 0o777, flag: "wx" });
    if (readFileSync(temporary, "utf8") !== text) throw new Error("read-back mismatch");
    renameSync(temporary, filePath);
    report.changed.push({ path: filePath });
  } catch (error) {
    rmSync(temporary, { force: true });
    report.skipped.push({ path: filePath, reason: `rewrite failed: ${describeError(error)}` });
  }
}

/** `record` with `legacyKey` renamed to `key` in place, or `record` itself when nothing moves. */
function renameKey(record: JsonObject, legacyKey: string, key: string, note: Note): JsonObject {
  if (!Object.hasOwn(record, legacyKey)) return record;
  if (Object.hasOwn(record, key)) {
    note(`both ${legacyKey} and ${key} are set; kept both`);
    return record;
  }
  const next: JsonObject = {};
  for (const [name, value] of Object.entries(record)) next[name === legacyKey ? key : name] = value;
  return next;
}

function renameLabels(labels: JsonObject, note: Note): JsonObject {
  let next = labels;
  for (const label of Object.keys(labels)) {
    if (!label.startsWith(LEGACY_LABEL_PREFIX)) continue;
    const renamed = `${LABEL_PREFIX}${label.slice(LEGACY_LABEL_PREFIX.length)}`;
    next = renameKey(next, label, renamed, note);
  }
  return next;
}

// --- Agent skill homes (outside the alp home) ---------------------------------------------

function skillRoots(userHome: string): string[] {
  return [
    path.join(userHome, ".agents", "skills"),
    path.join(userHome, ".claude", "skills"),
    path.join(userHome, ".codex", "skills"),
  ];
}

function rewriteTransactionEntries(
  entries: unknown[],
  legacyName: string,
  name: string,
): unknown[] {
  return entries.map((entry) => {
    if (!isObject(entry) || typeof entry.backupPath !== "string") return entry;
    const backupPath = entry.backupPath;
    if (!path.isAbsolute(backupPath) || path.basename(path.dirname(backupPath)) !== legacyName) {
      return entry;
    }
    const stageRoot = path.dirname(path.dirname(backupPath));
    return { ...entry, backupPath: path.join(stageRoot, name, path.basename(backupPath)) };
  });
}

/**
 * A skills save that died mid-flight leaves a transaction directory whose staged copies are the
 * only place some of the user's files exist. The renamed build recovers only transactions under
 * its own prefix and owner, so each one is carried over whole: its same-filesystem stages in the
 * skill roots, the manifests inside its captured copies, its manifest, then the directory.
 */
function migrateSkillTransaction(
  parent: string,
  legacyName: string,
  roots: string[],
  report: PreRenameMigrationReport,
): void {
  const legacyDir = path.join(parent, legacyName);
  const name = `${TRANSACTION_PREFIX}${legacyName.slice(LEGACY_TRANSACTION_PREFIX.length)}`;
  const targetDir = path.join(parent, name);
  if (!isDirectory(legacyDir)) return;
  if (existsSync(targetDir)) {
    report.skipped.push({ path: legacyDir, reason: `${name} already exists` });
    return;
  }
  const manifestPath = path.join(legacyDir, "transaction.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    report.skipped.push({
      path: legacyDir,
      reason: `no readable transaction.json: ${describeError(error)}`,
    });
    return;
  }
  if (
    !isObject(manifest) ||
    (manifest.owner !== LEGACY_TRANSACTION_OWNER && manifest.owner !== TRANSACTION_OWNER) ||
    !Array.isArray(manifest.entries)
  ) {
    report.skipped.push({
      path: legacyDir,
      reason: "transaction.json is not a skills transaction",
    });
    return;
  }

  for (const root of roots) {
    moveUnlessTaken(path.join(root, legacyName), path.join(root, name), report);
  }
  const entries = rewriteTransactionEntries(manifest.entries, legacyName, name);
  for (const entry of entries) {
    if (!isObject(entry) || typeof entry.backupPath !== "string") continue;
    const copy = path.isAbsolute(entry.backupPath)
      ? entry.backupPath
      : path.join(legacyDir, entry.backupPath);
    if (isDirectory(copy)) {
      moveUnlessTaken(
        path.join(copy, LEGACY_MANAGED_FILES),
        path.join(copy, MANAGED_FILES),
        report,
      );
    }
  }
  const migrated = { ...manifest, owner: TRANSACTION_OWNER, entries };
  rewriteJson(
    manifestPath,
    () => true,
    () => migrated,
    report,
  );
  moveUnlessTaken(legacyDir, targetDir, report);
}

function migrateSkillHomes(userHome: string, report: PreRenameMigrationReport): void {
  const roots = skillRoots(userHome);
  for (const parent of new Set(roots.map((root) => path.dirname(root)))) {
    for (const entry of listDirectory(parent)) {
      if (entry.startsWith(LEGACY_TRANSACTION_PREFIX)) {
        migrateSkillTransaction(parent, entry, roots, report);
      }
    }
  }
  for (const root of roots) {
    for (const entry of listDirectory(root)) {
      const skillDir = path.join(root, entry);
      if (!isDirectory(skillDir)) continue;
      moveUnlessTaken(
        path.join(skillDir, LEGACY_MANAGED_FILES),
        path.join(skillDir, MANAGED_FILES),
        report,
      );
    }
  }
}

// --- The alp home -----------------------------------------------------------------------------

function migrateConfig(alpHome: string, report: PreRenameMigrationReport): void {
  rewriteJson(
    path.join(alpHome, "config.json"),
    (raw) => raw.includes('"paseoTools"'),
    (config, note) => {
      if (!isObject(config) || !isObject(config.agents) || !isObject(config.agents.providers)) {
        return config;
      }
      let changed = false;
      const providers: JsonObject = {};
      for (const [id, provider] of Object.entries(config.agents.providers)) {
        const next = isObject(provider)
          ? renameKey(provider, "paseoTools", "alpTools", note)
          : provider;
        changed ||= next !== provider;
        providers[id] = next;
      }
      return changed ? { ...config, agents: { ...config.agents, providers } } : config;
    },
    report,
  );
}

function migrateAgentRecord(record: unknown, note: Note): unknown {
  if (!isObject(record)) return record;
  let next = renameKey(record, "paseoToolPolicy", "alpToolPolicy", note);
  if (isObject(next.labels)) {
    const labels = renameLabels(next.labels, note);
    if (labels !== next.labels) next = { ...next, labels };
  }
  return next;
}

/** Agent records sit at `agents/<id>.json` or one level down, `agents/<project>/<id>.json`. */
function migrateAgentRecords(alpHome: string, report: PreRenameMigrationReport): void {
  const agentsDir = path.join(alpHome, "agents");
  const files: string[] = [];
  for (const entry of listDirectory(agentsDir)) {
    const entryPath = path.join(agentsDir, entry);
    if (entry.endsWith(".json")) {
      files.push(entryPath);
    } else if (isDirectory(entryPath)) {
      for (const file of listDirectory(entryPath)) {
        if (file.endsWith(".json")) files.push(path.join(entryPath, file));
      }
    }
  }
  for (const file of files) {
    rewriteJson(
      file,
      (raw) => raw.includes('"paseo.') || raw.includes('"paseoToolPolicy"'),
      migrateAgentRecord,
      report,
    );
  }
}

function migrateWorkspaceRecords(alpHome: string, report: PreRenameMigrationReport): void {
  rewriteJson(
    path.join(alpHome, "projects", "workspaces.json"),
    (raw) => raw.includes('"isPaseoOwnedWorktree"'),
    (records, note) => {
      if (!Array.isArray(records)) return records;
      let changed = false;
      const next = records.map((record) => {
        if (!isObject(record)) return record;
        const renamed = renameKey(record, "isPaseoOwnedWorktree", "isAlpOwnedWorktree", note);
        changed ||= renamed !== record;
        return renamed;
      });
      return changed ? next : records;
    },
    report,
  );
}

function resolveGitDir(worktreeRoot: string): string | null {
  const gitPath = path.join(worktreeRoot, ".git");
  try {
    if (lstatSync(gitPath).isDirectory()) return gitPath;
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitPath, "utf8"));
    return match ? path.resolve(worktreeRoot, match[1]!.trim()) : null;
  } catch {
    return null;
  }
}

/**
 * The daemon records each worktree's base under its git dir; diffs and archive read it. It is
 * copied, not moved, so a 1.0.0 daemon still running beside this one keeps its own copy.
 */
function migrateWorktreeMetadata(alpHome: string, report: PreRenameMigrationReport): void {
  let records: unknown;
  try {
    records = JSON.parse(readFileSync(path.join(alpHome, "projects", "workspaces.json"), "utf8"));
  } catch {
    return;
  }
  if (!Array.isArray(records)) return;
  const roots = new Set<string>();
  for (const record of records) {
    if (!isObject(record) || record.kind !== "worktree") continue;
    const root = typeof record.worktreeRoot === "string" ? record.worktreeRoot : record.cwd;
    if (typeof root === "string") roots.add(root);
  }
  for (const root of roots) {
    const gitDir = resolveGitDir(root);
    if (!gitDir) continue;
    const legacy = path.join(gitDir, LEGACY_WORKTREE_METADATA_DIR, "worktree.json");
    const target = path.join(gitDir, WORKTREE_METADATA_DIR, "worktree.json");
    if (!existsSync(legacy) || existsSync(target)) continue;
    try {
      mkdirSync(path.dirname(target), { recursive: true });
      copyFileSync(legacy, target, constants.COPYFILE_EXCL);
      if (!readFileSync(target).equals(readFileSync(legacy))) {
        rmSync(target, { force: true });
        throw new Error("read-back mismatch");
      }
      report.changed.push({ path: legacy, to: target });
    } catch (error) {
      report.skipped.push({ path: legacy, reason: describeError(error) });
    }
  }
}

/** Runs at daemon start, before config and stores are read. Never throws. */
export function migratePreRenameState(input: {
  alpHome: string;
  userHome?: string;
}): PreRenameMigrationReport {
  const report: PreRenameMigrationReport = { changed: [], skipped: [] };
  const steps: Array<[string, () => void]> = [
    ["agent skill homes", () => migrateSkillHomes(input.userHome ?? os.homedir(), report)],
    ["config.json", () => migrateConfig(input.alpHome, report)],
    ["agents", () => migrateAgentRecords(input.alpHome, report)],
    ["workspaces", () => migrateWorkspaceRecords(input.alpHome, report)],
    ["worktree metadata", () => migrateWorktreeMetadata(input.alpHome, report)],
  ];
  // Each step stands alone: one that fails leaves its state for the next start.
  for (const [name, step] of steps) {
    try {
      step();
    } catch (error) {
      report.skipped.push({ path: name, reason: describeError(error) });
    }
  }
  return report;
}

export function logPreRenameMigration(
  logger: MigrationLogger,
  report: PreRenameMigrationReport,
): void {
  for (const step of report.changed) {
    logger.info({ path: step.path, to: step.to }, "Migrated state written before the alp rename");
  }
  for (const step of report.skipped) {
    logger.warn(
      { path: step.path, reason: step.reason },
      "Left state written before the alp rename where it is",
    );
  }
}
