// alp-rename-keep-file: the fixture is a home written by alp 1.0.0, under its pre-rename names.
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";
import { getParentAgentIdFromLabels } from "@alp/protocol/agent-labels";

import { resolveAlpHome } from "../alp-home.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { loadPersistedConfig } from "../persisted-config.js";
import { acquirePidLock, getPidLockInfo } from "../pid-lock.js";
import { readAlpConfig } from "../../utils/worktree.js";
import { readAlpWorktreeMetadata } from "../../utils/worktree-metadata.js";
import { setLegacyNameReporter, type LegacyNameUse } from "./legacy-names.js";
import { migratePreRenameState } from "./home-state.js";
import { resolveSkillTargets } from "../orchestration-skills/internal/paths.js";
import { recoverInterruptedSkillTransactions } from "../orchestration-skills/internal/transaction.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function agentRecord(id: string, labels: Record<string, string>, extra: object = {}) {
  return {
    id,
    provider: "claude",
    cwd: "/repo",
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
    labels,
    lastStatus: "closed",
    ...extra,
  };
}

/** Every file under `dir` with its contents, so a second run can be compared byte for byte. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[path.relative(dir, full)] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return files;
}

/** A machine as alp 1.0.0 left it: its home, the three agent skill homes, and one repo. */
function buildReleasedHome() {
  const root = mkdtempSync(path.join(tmpdir(), "alp-rename-fixture-"));
  roots.push(root);
  const alpHome = path.join(root, "alp-home");
  const userHome = path.join(root, "user");
  const repo = path.join(root, "repo");
  mkdirSync(alpHome, { recursive: true });

  writeFileSync(
    path.join(alpHome, "paseo.pid"),
    JSON.stringify({
      pid: process.pid,
      startedAt: "2000-01-01T00:00:00.000Z",
      hostname: "old-host",
      uid: 0,
      listen: "127.0.0.1:6767",
      heartbeat: true,
    }),
  );

  const configPath = path.join(alpHome, "config.json");
  writeJson(configPath, {
    version: 1,
    agents: { providers: { claude: { paseoTools: { disabledTools: ["archive_agent"] } } } },
  });
  chmodSync(configPath, 0o600);

  writeJson(
    path.join(alpHome, "agents", "repo-hash", "lead.json"),
    agentRecord("lead", { "paseo.schedule-id": "sched-1", "paseo.schedule-run": "run-1" }),
  );
  writeJson(
    path.join(alpHome, "agents", "repo-hash", "peer.json"),
    agentRecord(
      "peer",
      {
        "paseo.parent-agent-id": "lead",
        "paseo.open-agent-tab.client-1": "true",
        "slp.role": "peer",
      },
      { paseoToolPolicy: { disabledTools: ["create_agent"] } },
    ),
  );
  mkdirSync(path.join(alpHome, "agents", "repo-hash"), { recursive: true });
  writeFileSync(path.join(alpHome, "agents", "repo-hash", "broken.json"), '{"labels": {"paseo.');

  const worktree = path.join(root, "worktrees", "feature");
  const gitDir = path.join(repo, ".git", "worktrees", "feature");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
  writeJson(path.join(gitDir, "paseo", "worktree.json"), { version: 1, baseRefName: "main" });
  writeJson(path.join(alpHome, "projects", "workspaces.json"), [
    {
      workspaceId: "ws-1",
      projectId: "p-1",
      cwd: worktree,
      kind: "worktree",
      displayName: "feature",
      worktreeRoot: worktree,
      isPaseoOwnedWorktree: true,
      createdAt: "2026-09-27T00:00:00.000Z",
      updatedAt: "2026-09-27T00:00:00.000Z",
      archivedAt: null,
    },
  ]);

  const skillRoots = {
    agents: path.join(userHome, ".agents", "skills"),
    claude: path.join(userHome, ".claude", "skills"),
    codex: path.join(userHome, ".codex", "skills"),
  };
  const manifest = { version: 1, files: { "SKILL.md": "hash" } };
  for (const skillRoot of Object.values(skillRoots)) {
    writeFileSync(path.join(mkdirp(path.join(skillRoot, "alp-help")), "SKILL.md"), "# help\n");
    writeJson(path.join(skillRoot, "alp-help", ".paseo-managed-files.json"), manifest);
  }
  // Both names present: someone already wrote the new one, so the old one is left alone.
  writeJson(path.join(skillRoots.codex, "alp", ".paseo-managed-files.json"), manifest);
  writeJson(path.join(skillRoots.codex, "alp", ".alp-managed-files.json"), manifest);

  // A save interrupted mid-flight: its staged copies are the only place those files exist.
  const transactionDir = path.join(userHome, ".agents", ".paseo-skills-transaction-t1");
  const stagedDelete = path.join(skillRoots.claude, ".paseo-skills-transaction-t1", "alp-plugin");
  writeJson(path.join(stagedDelete, ".paseo-managed-files.json"), manifest);
  writeJson(
    path.join(transactionDir, "backup", "0", "alp-help", ".paseo-managed-files.json"),
    manifest,
  );
  writeJson(path.join(transactionDir, "transaction.json"), {
    owner: "paseo-skills-transaction",
    version: 1,
    phase: "converging",
    previousSelection: { mode: "all" },
    nextSelection: { mode: "custom", skills: ["alp-help"] },
    entries: [
      {
        livePath: path.join(skillRoots.agents, "alp-help"),
        kind: "update",
        backupPath: "backup/0/alp-help",
      },
      {
        livePath: path.join(skillRoots.claude, "alp-plugin"),
        kind: "delete",
        backupPath: stagedDelete,
      },
    ],
  });

  mkdirSync(repo, { recursive: true });
  writeJson(path.join(repo, "paseo.json"), { scripts: { web: { command: "npm run web" } } });

  return {
    root,
    alpHome,
    userHome,
    repo,
    worktree,
    gitDir,
    skillRoots,
    transactionDir,
    configPath,
  };
}

function mkdirp(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("migratePreRenameState on a home written by alp 1.0.0", () => {
  test("starts on the old home and keeps agents, links, skills, and repo config", async () => {
    const fixture = buildReleasedHome();
    const uses: LegacyNameUse[] = [];
    setLegacyNameReporter((use) => uses.push(use));

    // Start: the home comes from PASEO_HOME alone.
    const alpHome = resolveAlpHome({ PASEO_HOME: fixture.alpHome });
    expect(alpHome).toBe(fixture.alpHome);
    const report = migratePreRenameState({ alpHome, userHome: fixture.userHome });
    await acquirePidLock(alpHome, null, { ownerPid: process.pid + 10_000 });

    // The lock is alp.pid.
    expect(existsSync(path.join(alpHome, "paseo.pid"))).toBe(false);
    expect((await getPidLockInfo(alpHome))?.pid).toBe(process.pid + 10_000);

    // Agents read back with their parent, schedule, and tab links under the new labels.
    const storage = new AgentStorage(path.join(alpHome, "agents"), pino({ level: "silent" }));
    const peer = await storage.get("peer");
    expect(getParentAgentIdFromLabels(peer?.labels)).toBe("lead");
    expect(peer?.labels).toEqual({
      "alp.parent-agent-id": "lead",
      "alp.open-agent-tab.client-1": "true",
      "slp.role": "peer",
    });
    expect(peer?.alpToolPolicy).toEqual({ disabledTools: ["create_agent"] });
    expect((await storage.get("lead"))?.labels).toEqual({
      "alp.schedule-id": "sched-1",
      "alp.schedule-run": "run-1",
    });

    // A file that cannot be parsed is reported and left exactly as it was.
    expect(readFileSync(path.join(alpHome, "agents", "repo-hash", "broken.json"), "utf8")).toBe(
      '{"labels": {"paseo.',
    );
    expect(report.skipped).toContainEqual(
      expect.objectContaining({ path: path.join(alpHome, "agents", "repo-hash", "broken.json") }),
    );

    // config.json keeps the provider's tool policy under its new key, still private.
    expect(loadPersistedConfig(alpHome).agents?.providers?.claude?.alpTools).toEqual({
      disabledTools: ["archive_agent"],
    });
    expect(statSync(fixture.configPath).mode & 0o777).toBe(0o600);

    // The worktree stays owned and keeps its base.
    expect(readJson(path.join(alpHome, "projects", "workspaces.json"))).toMatchObject([
      { isAlpOwnedWorktree: true },
    ]);
    expect(readAlpWorktreeMetadata(fixture.worktree)).toEqual({ version: 1, baseRefName: "main" });

    // Every managed skill directory keeps its manifest; a directory with both names is left.
    for (const skillRoot of Object.values(fixture.skillRoots)) {
      expect(readdirSync(path.join(skillRoot, "alp-help")).sort()).toEqual([
        ".alp-managed-files.json",
        "SKILL.md",
      ]);
    }
    expect(readdirSync(path.join(fixture.skillRoots.codex, "alp")).sort()).toEqual([
      ".alp-managed-files.json",
      ".paseo-managed-files.json",
    ]);

    // The interrupted save is one the renamed build can recover.
    const migratedTransaction = path.join(
      fixture.userHome,
      ".agents",
      ".alp-skills-transaction-t1",
    );
    const stagedDelete = path.join(
      fixture.skillRoots.claude,
      ".alp-skills-transaction-t1",
      "alp-plugin",
    );
    expect(existsSync(fixture.transactionDir)).toBe(false);
    expect(readJson(path.join(migratedTransaction, "transaction.json"))).toMatchObject({
      owner: "alp-skills-transaction",
      entries: [
        { kind: "update", backupPath: "backup/0/alp-help" },
        { kind: "delete", backupPath: stagedDelete },
      ],
    });
    expect(readdirSync(stagedDelete)).toEqual([".alp-managed-files.json"]);
    expect(readdirSync(path.join(migratedTransaction, "backup", "0", "alp-help"))).toEqual([
      ".alp-managed-files.json",
    ]);

    // The repo's paseo.json is read, with a warning, and nothing is written into the repo.
    expect(readAlpConfig(fixture.repo)).toEqual({
      ok: true,
      config: { scripts: { web: { command: "npm run web" } } },
    });
    expect(readdirSync(fixture.repo).sort()).toEqual([".git", "paseo.json"]);
    expect(uses).toEqual(
      expect.arrayContaining([
        { kind: "env", legacy: "PASEO_HOME", current: "ALP_HOME" },
        {
          kind: "repo-config",
          legacy: "paseo.json",
          current: "alp.json",
          path: path.join(fixture.repo, "paseo.json"),
        },
      ]),
    );
  });

  test("the renamed build recovers a skills save 1.0.0 left interrupted", async () => {
    const fixture = buildReleasedHome();
    migratePreRenameState({ alpHome: fixture.alpHome, userHome: fixture.userHome });

    // The committed selection is the save's previous one, so recovery puts the staged
    // directory back rather than discarding it.
    await recoverInterruptedSkillTransactions(resolveSkillTargets(fixture.userHome), {
      mode: "all",
    });

    expect(readdirSync(path.join(fixture.skillRoots.claude, "alp-plugin"))).toEqual([
      ".alp-managed-files.json",
    ]);
    expect(existsSync(path.join(fixture.userHome, ".agents", ".alp-skills-transaction-t1"))).toBe(
      false,
    );
  });

  test("a second start changes nothing", () => {
    const fixture = buildReleasedHome();
    migratePreRenameState({ alpHome: fixture.alpHome, userHome: fixture.userHome });
    const before = snapshot(fixture.root);

    const report = migratePreRenameState({ alpHome: fixture.alpHome, userHome: fixture.userHome });

    expect(report.changed).toEqual([]);
    expect(snapshot(fixture.root)).toEqual(before);
  });

  test("a home with nothing from 1.0.0 is left alone", () => {
    const root = mkdtempSync(path.join(tmpdir(), "alp-rename-empty-"));
    roots.push(root);

    const report = migratePreRenameState({
      alpHome: path.join(root, "missing-home"),
      userHome: path.join(root, "missing-user"),
    });

    expect(report).toEqual({ changed: [], skipped: [] });
    expect(readdirSync(root)).toEqual([]);
  });
});
