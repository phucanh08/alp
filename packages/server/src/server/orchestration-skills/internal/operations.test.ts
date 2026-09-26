import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  autoUpdateInstalledSkills,
  getSkillsStatus,
  installSkills,
  LEGACY_SKILL_NAMES,
  type SkillSelection,
  type SkillTargets,
  uninstallSkills,
  updateSkills,
} from "./operations";

const ALL_SKILLS: SkillSelection = { mode: "all" };
const ignoreWarnings = { warn: () => {} };

function only(...skills: string[]): SkillSelection {
  return { mode: "custom", skills };
}

interface Sandbox {
  root: string;
  targets: SkillTargets;
}

async function makeSandbox(): Promise<Sandbox> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-skills-"));
  const targets: SkillTargets = {
    sourceDir: path.join(root, "bundle"),
    agentsDir: path.join(root, "home", ".agents", "skills"),
    claudeDir: path.join(root, "home", ".claude", "skills"),
    codexDir: path.join(root, "home", ".codex", "skills"),
  };
  await fs.mkdir(targets.sourceDir, { recursive: true });
  return { root, targets };
}

async function writeFiles(rootDir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(rootDir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
}

async function writeBundleSkill(
  sourceDir: string,
  name: string,
  files: Record<string, string>,
): Promise<void> {
  await writeFiles(path.join(sourceDir, name), files);
}

async function writeOnDiskSkill(
  agentsDir: string,
  name: string,
  files: Record<string, string>,
): Promise<void> {
  await writeFiles(path.join(agentsDir, name), files);
}

async function writeOnDiskSkillToAllTargets(
  targets: SkillTargets,
  name: string,
  files: Record<string, string>,
): Promise<void> {
  await Promise.all([
    writeOnDiskSkill(targets.agentsDir, name, files),
    writeOnDiskSkill(targets.claudeDir, name, files),
    writeOnDiskSkill(targets.codexDir, name, files),
  ]);
}

async function writeCurrentBundle(sourceDir: string): Promise<void> {
  await writeBundleSkill(sourceDir, "paseo", { "SKILL.md": "paseo-v1" });
  await writeBundleSkill(sourceDir, "paseo-loop", { "SKILL.md": "loop-v1" });
}

async function pathExists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

async function installedIn(targets: SkillTargets, name: string): Promise<boolean[]> {
  return Promise.all(
    [targets.agentsDir, targets.claudeDir, targets.codexDir].map((dir) =>
      pathExists(path.join(dir, name)),
    ),
  );
}

describe("getSkillsStatus", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await fs.rm(sandbox.root, { recursive: true, force: true });
  });

  it("returns not-installed with add ops for every bundled skill when nothing is on disk", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);

    const status = await getSkillsStatus(sandbox.targets, ALL_SKILLS);

    expect(status.state).toBe("not-installed");
    expect(status.ops).toEqual([
      { kind: "add", name: "paseo" },
      { kind: "add", name: "paseo-loop" },
    ]);
  });

  it("reports every bundled skill as available", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeBundleSkill(sandbox.targets.sourceDir, "paseo-advisor", {
      "SKILL.md": "advisor-v1",
    });

    const status = await getSkillsStatus(sandbox.targets, only("paseo"));

    expect(status.available).toEqual(["paseo", "paseo-advisor", "paseo-loop"]);
  });

  it("reports a skill present in only one target as installed", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkill(sandbox.targets.claudeDir, "paseo", { "SKILL.md": "paseo-v1" });

    const status = await getSkillsStatus(sandbox.targets, ALL_SKILLS);

    // `add` means "missing from at least one target", so it cannot answer
    // "is there a directory here to delete". `installed` answers that.
    expect(status.installed).toEqual(["paseo"]);
    expect(status.ops).toEqual([
      { kind: "add", name: "paseo" },
      { kind: "add", name: "paseo-loop" },
    ]);
  });

  it("reports legacy skill directories left on disk as installed", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo-chat", { "SKILL.md": "chat-old" });

    expect((await getSkillsStatus(sandbox.targets, ALL_SKILLS)).installed).toEqual(["paseo-chat"]);
  });

  it("returns not-installed when only user-personal skill dirs exist (the live bug)", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    for (const name of ["unslop", "tdd", "devbox"]) {
      await writeOnDiskSkill(sandbox.targets.agentsDir, name, { "SKILL.md": `user-${name}` });
    }

    const status = await getSkillsStatus(sandbox.targets, ALL_SKILLS);

    expect(status.state).toBe("not-installed");
    expect(status.ops).toEqual([
      { kind: "add", name: "paseo" },
      { kind: "add", name: "paseo-loop" },
    ]);
  });

  it("returns up-to-date when every bundled skill matches on disk", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkillToAllTargets(sandbox.targets, "paseo", { "SKILL.md": "paseo-v1" });
    await writeOnDiskSkillToAllTargets(sandbox.targets, "paseo-loop", { "SKILL.md": "loop-v1" });

    const status = await getSkillsStatus(sandbox.targets, ALL_SKILLS);

    expect(status).toEqual({
      state: "up-to-date",
      ops: [],
      available: ["paseo", "paseo-loop"],
      installed: ["paseo", "paseo-loop"],
    });
  });

  it("ignores user-added files inside current managed skill dirs in every target", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkillToAllTargets(sandbox.targets, "paseo", { "SKILL.md": "paseo-v1" });
    await writeOnDiskSkillToAllTargets(sandbox.targets, "paseo-loop", { "SKILL.md": "loop-v1" });
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo", {
      "SKILL.md": "paseo-v1",
      "my-context.md": "user context",
    });
    await writeOnDiskSkill(sandbox.targets.claudeDir, "paseo", {
      "SKILL.md": "paseo-v1",
      "commands/local.md": "user command",
    });
    await writeOnDiskSkill(sandbox.targets.codexDir, "paseo", {
      "SKILL.md": "paseo-v1",
      "hooks/guard.sh": "user guard",
    });

    const status = await getSkillsStatus(sandbox.targets, ALL_SKILLS);

    expect(status).toEqual({
      state: "up-to-date",
      ops: [],
      available: ["paseo", "paseo-loop"],
      installed: ["paseo", "paseo-loop"],
    });
  });

  it("returns drift with a single update op when one bundled file diverges", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo", { "SKILL.md": "stale" });
    await writeOnDiskSkill(sandbox.targets.claudeDir, "paseo", { "SKILL.md": "paseo-v1" });
    await writeOnDiskSkill(sandbox.targets.codexDir, "paseo", { "SKILL.md": "paseo-v1" });
    await writeOnDiskSkillToAllTargets(sandbox.targets, "paseo-loop", { "SKILL.md": "loop-v1" });

    const status = await getSkillsStatus(sandbox.targets, ALL_SKILLS);

    expect(status.state).toBe("drift");
    expect(status.ops).toEqual([{ kind: "update", name: "paseo" }]);
  });

  it("returns drift when a secondary agent target is stale", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo", { "SKILL.md": "paseo-v1" });
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo-loop", { "SKILL.md": "loop-v1" });
    await writeOnDiskSkill(sandbox.targets.claudeDir, "paseo", { "SKILL.md": "stale" });
    await writeOnDiskSkill(sandbox.targets.claudeDir, "paseo-loop", { "SKILL.md": "loop-v1" });
    await writeOnDiskSkill(sandbox.targets.codexDir, "paseo", { "SKILL.md": "paseo-v1" });
    await writeOnDiskSkill(sandbox.targets.codexDir, "paseo-loop", { "SKILL.md": "loop-v1" });

    const status = await getSkillsStatus(sandbox.targets, ALL_SKILLS);

    expect(status.state).toBe("drift");
    expect(status.ops).toEqual([{ kind: "update", name: "paseo" }]);
  });

  it("returns drift with add ops for the bundled skills missing from disk", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkillToAllTargets(sandbox.targets, "paseo", { "SKILL.md": "paseo-v1" });

    const status = await getSkillsStatus(sandbox.targets, ALL_SKILLS);

    expect(status.state).toBe("drift");
    expect(status.ops).toEqual([{ kind: "add", name: "paseo-loop" }]);
  });

  it("returns drift with a delete op for a legacy skill name still on disk", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkillToAllTargets(sandbox.targets, "paseo", { "SKILL.md": "paseo-v1" });
    await writeOnDiskSkillToAllTargets(sandbox.targets, "paseo-loop", { "SKILL.md": "loop-v1" });
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo-chat", { "SKILL.md": "chat-old" });

    const status = await getSkillsStatus(sandbox.targets, ALL_SKILLS);

    expect(status.state).toBe("drift");
    expect(status.ops).toEqual([{ kind: "delete", name: "paseo-chat" }]);
  });

  it("emits add + update + delete ops sorted by name when state is mixed", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo", { "SKILL.md": "stale" });
    await writeOnDiskSkill(sandbox.targets.claudeDir, "paseo", { "SKILL.md": "paseo-v1" });
    await writeOnDiskSkill(sandbox.targets.codexDir, "paseo", { "SKILL.md": "paseo-v1" });
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo-chat", { "SKILL.md": "chat-old" });

    const status = await getSkillsStatus(sandbox.targets, ALL_SKILLS);

    expect(status.state).toBe("drift");
    expect(status.ops).toEqual([
      { kind: "update", name: "paseo" },
      { kind: "delete", name: "paseo-chat" },
      { kind: "add", name: "paseo-loop" },
    ]);
  });
});

describe("custom skill selection", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeBundleSkill(sandbox.targets.sourceDir, "paseo-advisor", {
      "SKILL.md": "advisor-v1",
    });
  });

  afterEach(async () => {
    await fs.rm(sandbox.root, { recursive: true, force: true });
  });

  it("installs only the selected skills", async () => {
    const status = await installSkills(sandbox.targets, only("paseo", "paseo-loop"));

    expect(status).toEqual({
      state: "up-to-date",
      ops: [],
      available: ["paseo", "paseo-advisor", "paseo-loop"],
      installed: ["paseo", "paseo-loop"],
    });
    expect(await installedIn(sandbox.targets, "paseo")).toEqual([true, true, true]);
    expect(await installedIn(sandbox.targets, "paseo-loop")).toEqual([true, true, true]);
    expect(await installedIn(sandbox.targets, "paseo-advisor")).toEqual([false, false, false]);
  });

  it("reports up-to-date while an unselected bundled skill is absent", async () => {
    await installSkills(sandbox.targets, only("paseo"));

    const status = await getSkillsStatus(sandbox.targets, only("paseo"));

    expect(status).toEqual({
      state: "up-to-date",
      ops: [],
      available: ["paseo", "paseo-advisor", "paseo-loop"],
      installed: ["paseo"],
    });
  });

  it("removes a previously installed skill once it leaves the selection", async () => {
    await installSkills(sandbox.targets, ALL_SKILLS);

    const status = await installSkills(sandbox.targets, only("paseo"));

    expect(status.state).toBe("up-to-date");
    expect(await installedIn(sandbox.targets, "paseo")).toEqual([true, true, true]);
    expect(await installedIn(sandbox.targets, "paseo-loop")).toEqual([false, false, false]);
    expect(await installedIn(sandbox.targets, "paseo-advisor")).toEqual([false, false, false]);
  });

  it("reports a delete op for a deselected skill before it is applied", async () => {
    await installSkills(sandbox.targets, ALL_SKILLS);

    const status = await getSkillsStatus(sandbox.targets, only("paseo", "paseo-advisor"));

    expect(status.state).toBe("drift");
    expect(status.ops).toEqual([{ kind: "delete", name: "paseo-loop" }]);
  });

  it("leaves unrelated user skills untouched", async () => {
    await writeOnDiskSkill(sandbox.targets.agentsDir, "unslop", { "SKILL.md": "user-unslop" });

    await installSkills(sandbox.targets, only("paseo"));

    expect(
      await fs.readFile(path.join(sandbox.targets.agentsDir, "unslop", "SKILL.md"), "utf-8"),
    ).toBe("user-unslop");
  });

  it("treats an empty custom selection as no managed skills installed", async () => {
    await installSkills(sandbox.targets, ALL_SKILLS);

    const status = await installSkills(sandbox.targets, only());

    expect(status).toEqual({
      state: "not-installed",
      ops: [],
      available: ["paseo", "paseo-advisor", "paseo-loop"],
      installed: [],
    });
    expect(await installedIn(sandbox.targets, "paseo")).toEqual([false, false, false]);
    expect(await installedIn(sandbox.targets, "paseo-loop")).toEqual([false, false, false]);
  });

  it("ignores selected names that the bundle does not ship", async () => {
    const status = await installSkills(sandbox.targets, only("paseo", "not-a-skill"));

    expect(status).toEqual({
      state: "up-to-date",
      ops: [],
      available: ["paseo", "paseo-advisor", "paseo-loop"],
      installed: ["paseo"],
    });
    expect(await installedIn(sandbox.targets, "not-a-skill")).toEqual([false, false, false]);
  });

  it("still deletes legacy skill names that are not selectable", async () => {
    await writeOnDiskSkillToAllTargets(sandbox.targets, "paseo-orchestrator", {
      "SKILL.md": "orchestrator-old",
    });

    await installSkills(sandbox.targets, only("paseo"));

    expect(await installedIn(sandbox.targets, "paseo-orchestrator")).toEqual([false, false, false]);
  });
});

describe("installSkills / updateSkills", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await fs.rm(sandbox.root, { recursive: true, force: true });
  });

  it("installs from a clean machine, populates all three targets, and leaves user dirs alone", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkill(sandbox.targets.agentsDir, "unslop", { "SKILL.md": "user-unslop" });

    const status = await installSkills(sandbox.targets, ALL_SKILLS);

    expect(status).toEqual({
      state: "up-to-date",
      ops: [],
      available: ["paseo", "paseo-loop"],
      installed: ["paseo", "paseo-loop"],
    });
    for (const name of ["paseo", "paseo-loop"]) {
      expect(
        await fs.readFile(path.join(sandbox.targets.agentsDir, name, "SKILL.md"), "utf-8"),
      ).toBe(name === "paseo" ? "paseo-v1" : "loop-v1");
      expect(
        await fs.readFile(path.join(sandbox.targets.codexDir, name, "SKILL.md"), "utf-8"),
      ).toBe(name === "paseo" ? "paseo-v1" : "loop-v1");
      expect(await pathExists(path.join(sandbox.targets.claudeDir, name))).toBe(true);
    }
    expect(
      await fs.readFile(path.join(sandbox.targets.agentsDir, "unslop", "SKILL.md"), "utf-8"),
    ).toBe("user-unslop");
  });

  it("repairs missing and edited skills without deleting a legacy directory", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo", { "SKILL.md": "stale" });
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo-chat", { "SKILL.md": "chat-old" });
    await writeOnDiskSkill(sandbox.targets.claudeDir, "paseo-chat", { "SKILL.md": "chat-old" });
    await writeOnDiskSkill(sandbox.targets.codexDir, "paseo-chat", { "SKILL.md": "chat-old" });

    const status = await updateSkills(sandbox.targets, ALL_SKILLS, { logger: ignoreWarnings });

    expect(status).toEqual({
      state: "drift",
      ops: [{ kind: "delete", name: "paseo-chat" }],
      available: ["paseo", "paseo-loop"],
      installed: ["paseo", "paseo-chat", "paseo-loop"],
    });
    expect(
      await fs.readFile(path.join(sandbox.targets.agentsDir, "paseo", "SKILL.md"), "utf-8"),
    ).toBe("paseo-v1");
    expect(
      await fs.readFile(path.join(sandbox.targets.agentsDir, "paseo-loop", "SKILL.md"), "utf-8"),
    ).toBe("loop-v1");
    for (const dir of [
      sandbox.targets.agentsDir,
      sandbox.targets.claudeDir,
      sandbox.targets.codexDir,
    ]) {
      expect(await pathExists(path.join(dir, "paseo-chat"))).toBe(true);
    }
  });

  it("defines updated as the state reached after preserving user files", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkillToAllTargets(sandbox.targets, "paseo", { "SKILL.md": "paseo-v1" });
    await writeOnDiskSkillToAllTargets(sandbox.targets, "paseo-loop", { "SKILL.md": "loop-v1" });
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo", {
      "SKILL.md": "stale",
      "hooks/guard.sh": "user guard",
    });
    await writeOnDiskSkill(sandbox.targets.claudeDir, "paseo", {
      "SKILL.md": "paseo-v1",
      "notes/local.md": "claude notes",
    });
    await writeOnDiskSkill(sandbox.targets.codexDir, "paseo", {
      "SKILL.md": "paseo-v1",
      "prompts/local.md": "codex prompt",
    });

    const status = await updateSkills(sandbox.targets, ALL_SKILLS, { logger: ignoreWarnings });

    expect(status.state).toBe("up-to-date");
    expect(await getSkillsStatus(sandbox.targets, ALL_SKILLS)).toEqual({
      state: "up-to-date",
      ops: [],
      available: ["paseo", "paseo-loop"],
      installed: ["paseo", "paseo-loop"],
    });
    expect(
      await fs.readFile(
        path.join(sandbox.targets.agentsDir, "paseo", "hooks", "guard.sh"),
        "utf-8",
      ),
    ).toBe("user guard");
    expect(
      await fs.readFile(
        path.join(sandbox.targets.claudeDir, "paseo", "notes", "local.md"),
        "utf-8",
      ),
    ).toBe("claude notes");
    expect(
      await fs.readFile(
        path.join(sandbox.targets.codexDir, "paseo", "prompts", "local.md"),
        "utf-8",
      ),
    ).toBe("codex prompt");
  });

  it("repairs secondary agent targets even when agents skills are current", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo", { "SKILL.md": "paseo-v1" });
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo-loop", { "SKILL.md": "loop-v1" });
    await writeOnDiskSkill(sandbox.targets.claudeDir, "paseo", { "SKILL.md": "paseo-v1" });
    await writeOnDiskSkill(sandbox.targets.codexDir, "paseo", { "SKILL.md": "paseo-v1" });
    await writeOnDiskSkill(sandbox.targets.codexDir, "paseo-loop", { "SKILL.md": "loop-v1" });

    const status = await updateSkills(sandbox.targets, ALL_SKILLS, { logger: ignoreWarnings });

    expect(status.state).toBe("up-to-date");
    expect(
      await fs.readFile(path.join(sandbox.targets.claudeDir, "paseo-loop", "SKILL.md"), "utf-8"),
    ).toBe("loop-v1");
  });

  it("auto-updates drifted installed skills", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo", {
      "SKILL.md": "stale",
      "hooks/guard.sh": "user guard",
    });

    const status = await autoUpdateInstalledSkills(sandbox.targets, ALL_SKILLS, {
      logger: ignoreWarnings,
    });

    expect(status.state).toBe("up-to-date");
    expect((await getSkillsStatus(sandbox.targets, ALL_SKILLS)).state).toBe("up-to-date");
    expect(
      await fs.readFile(path.join(sandbox.targets.agentsDir, "paseo", "SKILL.md"), "utf-8"),
    ).toBe("paseo-v1");
    expect(
      await fs.readFile(
        path.join(sandbox.targets.agentsDir, "paseo", "hooks", "guard.sh"),
        "utf-8",
      ),
    ).toBe("user guard");
  });

  it("installs the selected skills on a clean machine at startup", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);

    const status = await autoUpdateInstalledSkills(sandbox.targets, ALL_SKILLS, {
      logger: ignoreWarnings,
    });

    expect(status).toEqual({
      state: "up-to-date",
      ops: [],
      available: ["paseo", "paseo-loop"],
      installed: ["paseo", "paseo-loop"],
    });
    expect(await installedIn(sandbox.targets, "paseo")).toEqual([true, true, true]);
    expect(await installedIn(sandbox.targets, "paseo-loop")).toEqual([true, true, true]);
  });

  it("leaves a clean machine alone when the selection is empty", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);

    const status = await autoUpdateInstalledSkills(sandbox.targets, only(), {
      logger: ignoreWarnings,
    });

    expect(status.state).toBe("not-installed");
    expect(status.ops).toEqual([]);
    expect(await installedIn(sandbox.targets, "paseo")).toEqual([false, false, false]);
  });

  it("is idempotent — running install twice keeps state at up-to-date", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);

    const first = await installSkills(sandbox.targets, ALL_SKILLS);
    const second = await installSkills(sandbox.targets, ALL_SKILLS);

    expect(first.state).toBe("up-to-date");
    expect(second.state).toBe("up-to-date");
  });
});

describe("uninstallSkills", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await fs.rm(sandbox.root, { recursive: true, force: true });
  });

  it("removes every Paseo skill from all three targets and preserves user dirs", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await installSkills(sandbox.targets, ALL_SKILLS);
    for (const name of ["unslop", "tdd", "devbox"]) {
      await writeOnDiskSkill(sandbox.targets.agentsDir, name, { "SKILL.md": `user-${name}` });
    }

    const status = await uninstallSkills(sandbox.targets, ALL_SKILLS);

    expect(status.state).toBe("not-installed");
    for (const name of ["paseo", "paseo-loop", ...LEGACY_SKILL_NAMES]) {
      expect(await installedIn(sandbox.targets, name)).toEqual([false, false, false]);
    }
    for (const name of ["unslop", "tdd", "devbox"]) {
      expect(
        await fs.readFile(path.join(sandbox.targets.agentsDir, name, "SKILL.md"), "utf-8"),
      ).toBe(`user-${name}`);
    }
  });

  it("is a no-op when nothing is installed", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);

    const status = await uninstallSkills(sandbox.targets, ALL_SKILLS);

    expect(status.state).toBe("not-installed");
  });

  it("cleans up legacy skill names that linger in agents, claude, and codex", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    for (const dir of [
      sandbox.targets.agentsDir,
      sandbox.targets.claudeDir,
      sandbox.targets.codexDir,
    ]) {
      await writeOnDiskSkill(dir, "paseo-chat", { "SKILL.md": "chat-old" });
    }

    const status = await uninstallSkills(sandbox.targets, ALL_SKILLS);

    expect(status.state).toBe("not-installed");
    expect(await installedIn(sandbox.targets, "paseo-chat")).toEqual([false, false, false]);
  });
});

// ALP(rebrand): the bundle renamed its paseo* skills to alp*. A machine that ran
// an older release still holds the old directories, installed with a manifest.
describe("renamed skill cleanup", () => {
  const RENAMED: Record<string, string> = {
    paseo: "alp",
    "paseo-advisor": "alp-advisor",
    "paseo-committee": "alp-committee",
    "paseo-handoff": "alp-handoff",
    "paseo-help": "alp-help",
    "paseo-plugin": "alp-plugin",
  };
  const OLD_NAMES = Object.keys(RENAMED);
  const NEW_NAMES = Object.values(RENAMED).sort();

  let sandbox: Sandbox;
  let warn: ReturnType<typeof vi.fn>;
  let logger: { warn: (fields: Record<string, unknown>, message: string) => void };

  beforeEach(async () => {
    sandbox = await makeSandbox();
    warn = vi.fn();
    logger = { warn };
  });

  afterEach(async () => {
    await fs.rm(sandbox.root, { recursive: true, force: true });
  });

  function roots(): string[] {
    return [sandbox.targets.agentsDir, sandbox.targets.claudeDir, sandbox.targets.codexDir];
  }

  /** Install an older release through the real installer, then ship the renamed bundle. */
  async function upgradeFromOldRelease(extraOldNames: string[] = []): Promise<void> {
    for (const name of [...OLD_NAMES, ...extraOldNames]) {
      await writeBundleSkill(sandbox.targets.sourceDir, name, {
        "SKILL.md": `${name}-old`,
        "references/guide.md": `${name} guide`,
      });
    }
    await installSkills(sandbox.targets, ALL_SKILLS);
    await fs.rm(sandbox.targets.sourceDir, { recursive: true, force: true });
    await fs.mkdir(sandbox.targets.sourceDir, { recursive: true });
    for (const name of NEW_NAMES) {
      await writeBundleSkill(sandbox.targets.sourceDir, name, { "SKILL.md": `${name}-new` });
    }
  }

  async function expectNewSkillsInstalled(): Promise<void> {
    for (const name of NEW_NAMES) {
      for (const dir of roots()) {
        expect(await fs.readFile(path.join(dir, name, "SKILL.md"), "utf-8")).toBe(`${name}-new`);
      }
    }
  }

  function warnedPaths(): string[] {
    return warn.mock.calls.map(([fields]) => (fields as { path: string }).path);
  }

  it("removes clean old directories from all three roots on update", async () => {
    await upgradeFromOldRelease();

    const status = await updateSkills(sandbox.targets, ALL_SKILLS, { logger });

    for (const name of OLD_NAMES) {
      expect(await installedIn(sandbox.targets, name)).toEqual([false, false, false]);
    }
    await expectNewSkillsInstalled();
    expect(status.state).toBe("up-to-date");
    expect(status.installed).toEqual(NEW_NAMES);
    expect(warn).not.toHaveBeenCalled();
  });

  it("removes clean old directories from all three roots on auto-update", async () => {
    await upgradeFromOldRelease();

    const status = await autoUpdateInstalledSkills(sandbox.targets, ALL_SKILLS, { logger });

    for (const name of OLD_NAMES) {
      expect(await installedIn(sandbox.targets, name)).toEqual([false, false, false]);
    }
    await expectNewSkillsInstalled();
    expect(status.state).toBe("up-to-date");
    expect(warn).not.toHaveBeenCalled();
  });

  it("removes clean old directories even when the selection installs nothing", async () => {
    await upgradeFromOldRelease();

    const status = await autoUpdateInstalledSkills(sandbox.targets, only(), { logger });

    for (const name of OLD_NAMES) {
      expect(await installedIn(sandbox.targets, name)).toEqual([false, false, false]);
    }
    expect(status.state).toBe("not-installed");
  });

  it("keeps an old directory holding a file the manifest does not list", async () => {
    await upgradeFromOldRelease();
    const kept = path.join(sandbox.targets.claudeDir, "paseo");
    await writeFiles(kept, { "notes/mine.md": "user notes" });

    await updateSkills(sandbox.targets, ALL_SKILLS, { logger });

    expect(await fs.readFile(path.join(kept, "notes", "mine.md"), "utf-8")).toBe("user notes");
    expect(await fs.readFile(path.join(kept, "SKILL.md"), "utf-8")).toBe("paseo-old");
    expect(await fs.readFile(path.join(kept, "references", "guide.md"), "utf-8")).toBe(
      "paseo guide",
    );
    expect(await pathExists(path.join(kept, ".paseo-managed-files.json"))).toBe(true);
    expect(await installedIn(sandbox.targets, "paseo")).toEqual([false, true, false]);
    expect(warnedPaths()).toEqual([kept]);
    await expectNewSkillsInstalled();
  });

  it("keeps an old directory holding an empty directory the manifest does not explain", async () => {
    await upgradeFromOldRelease();
    const kept = path.join(sandbox.targets.agentsDir, "paseo-plugin");
    await fs.mkdir(path.join(kept, "drafts"));

    await updateSkills(sandbox.targets, ALL_SKILLS, { logger });

    expect(await pathExists(path.join(kept, "drafts"))).toBe(true);
    expect(await fs.readFile(path.join(kept, "SKILL.md"), "utf-8")).toBe("paseo-plugin-old");
    expect(await installedIn(sandbox.targets, "paseo-plugin")).toEqual([true, false, false]);
    expect(warnedPaths()).toEqual([kept]);
  });

  it("keeps an old directory whose managed file was edited", async () => {
    await upgradeFromOldRelease();
    const kept = path.join(sandbox.targets.codexDir, "paseo-help");
    await fs.writeFile(path.join(kept, "references", "guide.md"), "edited by user");

    await updateSkills(sandbox.targets, ALL_SKILLS, { logger });

    expect(await fs.readFile(path.join(kept, "references", "guide.md"), "utf-8")).toBe(
      "edited by user",
    );
    expect(await fs.readFile(path.join(kept, "SKILL.md"), "utf-8")).toBe("paseo-help-old");
    expect(await installedIn(sandbox.targets, "paseo-help")).toEqual([false, false, true]);
    expect(warnedPaths()).toEqual([kept]);
    await expectNewSkillsInstalled();
  });

  it("keeps an old directory without a manifest", async () => {
    await upgradeFromOldRelease();
    const kept = path.join(sandbox.targets.agentsDir, "paseo-advisor");
    await fs.rm(path.join(kept, ".paseo-managed-files.json"));

    await autoUpdateInstalledSkills(sandbox.targets, ALL_SKILLS, { logger });

    expect(await fs.readFile(path.join(kept, "SKILL.md"), "utf-8")).toBe("paseo-advisor-old");
    expect(await fs.readFile(path.join(kept, "references", "guide.md"), "utf-8")).toBe(
      "paseo-advisor guide",
    );
    expect(await installedIn(sandbox.targets, "paseo-advisor")).toEqual([true, false, false]);
    expect(warnedPaths()).toEqual([kept]);
    await expectNewSkillsInstalled();
  });

  it.skipIf(process.platform === "win32")(
    "keeps an old directory that is a symlink, and the directory it points to",
    async () => {
      await upgradeFromOldRelease();
      const link = path.join(sandbox.targets.codexDir, "paseo-committee");
      const real = path.join(sandbox.root, "dotfiles", "paseo-committee");
      await fs.mkdir(path.dirname(real), { recursive: true });
      await fs.rename(link, real);
      await fs.symlink(real, link, "dir");

      await updateSkills(sandbox.targets, ALL_SKILLS, { logger });

      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(path.join(real, "SKILL.md"), "utf-8")).toBe("paseo-committee-old");
      expect(await pathExists(path.join(real, ".paseo-managed-files.json"))).toBe(true);
      expect(warnedPaths()).toEqual([link]);
      await expectNewSkillsInstalled();
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps an old directory containing a symlink",
    async () => {
      await upgradeFromOldRelease();
      const kept = path.join(sandbox.targets.claudeDir, "paseo-handoff");
      const outside = path.join(sandbox.root, "outside");
      await writeFiles(outside, { "keep.md": "outside file" });
      await fs.symlink(outside, path.join(kept, "linked"), "dir");

      await updateSkills(sandbox.targets, ALL_SKILLS, { logger });

      expect((await fs.lstat(path.join(kept, "linked"))).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(path.join(kept, "SKILL.md"), "utf-8")).toBe("paseo-handoff-old");
      expect(await fs.readFile(path.join(outside, "keep.md"), "utf-8")).toBe("outside file");
      expect(warnedPaths()).toEqual([kept]);
    },
  );

  it("leaves a clean legacy directory outside the rename table alone", async () => {
    await upgradeFromOldRelease(["paseo-chat"]);

    const status = await updateSkills(sandbox.targets, ALL_SKILLS, { logger });

    expect(await installedIn(sandbox.targets, "paseo-chat")).toEqual([true, true, true]);
    expect(await installedIn(sandbox.targets, "paseo")).toEqual([false, false, false]);
    expect(status.ops).toEqual([{ kind: "delete", name: "paseo-chat" }]);
  });

  it("does not remove an old name the bundle still ships", async () => {
    await writeBundleSkill(sandbox.targets.sourceDir, "paseo", { "SKILL.md": "still-shipped" });
    await writeBundleSkill(sandbox.targets.sourceDir, "alp", { "SKILL.md": "alp-new" });
    await installSkills(sandbox.targets, ALL_SKILLS);

    // Deselected but still shipped: removing it is the interactive path's call.
    const status = await updateSkills(sandbox.targets, only("alp"), { logger });

    expect(await installedIn(sandbox.targets, "paseo")).toEqual([true, true, true]);
    expect(status.ops).toEqual([{ kind: "delete", name: "paseo" }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "still installs the new skills when removing an old directory fails",
    async () => {
      await upgradeFromOldRelease();
      const locked = path.join(sandbox.targets.agentsDir, "paseo");
      await fs.chmod(locked, 0o555);
      try {
        const status = await updateSkills(sandbox.targets, ALL_SKILLS, { logger });

        await expectNewSkillsInstalled();
        expect(await fs.readFile(path.join(locked, "SKILL.md"), "utf-8")).toBe("paseo-old");
        expect(await installedIn(sandbox.targets, "paseo")).toEqual([true, false, false]);
        expect(status.ops).toEqual([{ kind: "delete", name: "paseo" }]);
        expect(warnedPaths()).toEqual([locked]);
      } finally {
        await fs.chmod(locked, 0o755);
      }
    },
  );
});
