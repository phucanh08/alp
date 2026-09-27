import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DaemonConfigStore } from "../daemon-config-store";
import { createOrchestrationSkills } from "./index";
import type { SkillTargets } from "./internal/operations";
import type { SkillsLogger } from "./internal/renamed-skills";

interface PluginEntry {
  path: string;
  enabled?: boolean;
}

interface Harness {
  root: string;
  targets: SkillTargets;
  plugin(id: string, skills: string[], options?: { skillsDir?: string }): Promise<string>;
  skills(options: {
    pluginsEnabled?: boolean;
    plugins?: Record<string, PluginEntry>;
    bundled?: Record<string, string>;
    logger?: SkillsLogger;
  }): ReturnType<typeof createOrchestrationSkills>;
}

const roots: string[] = [];
const logger: SkillsLogger = { warn: () => {}, error: () => {} };

/** Captures every collision `logger.error` reports instead of ignoring them. */
function collectErrorLogs(): { logger: SkillsLogger; messages: string[] } {
  const messages: string[] = [];
  return {
    logger: {
      warn: () => {},
      error: (_fields, message) => {
        messages.push(message);
      },
    },
    messages,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeSkill(dir: string, name: string, contents: string): Promise<void> {
  await mkdir(path.join(dir, name), { recursive: true });
  await writeFile(path.join(dir, name, "SKILL.md"), contents);
}

async function makeHarness(coreSkills: string[] = ["alp"]): Promise<Harness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-plugin-skills-"));
  roots.push(root);
  const targets: SkillTargets = {
    sourceDir: path.join(root, "core"),
    agentsDir: path.join(root, "home", ".agents", "skills"),
    claudeDir: path.join(root, "home", ".claude", "skills"),
    codexDir: path.join(root, "home", ".codex", "skills"),
  };
  for (const name of coreSkills) await writeSkill(targets.sourceDir, name, `core ${name}`);
  let stores = 0;
  return {
    root,
    targets,
    async plugin(id, skills, options = {}) {
      const directory = path.join(root, "plugins", id);
      const skillsDir = options.skillsDir ?? "skills";
      await mkdir(directory, { recursive: true });
      await writeFile(
        path.join(directory, "paseo-plugin.json"),
        JSON.stringify({ id, skills: skillsDir }),
      );
      for (const name of skills) {
        await writeSkill(path.join(directory, skillsDir), name, `${id} ${name}`);
      }
      return directory;
    },
    skills({ pluginsEnabled = true, plugins = {}, bundled = {}, logger: loggerOverride }) {
      stores += 1;
      const configStore = new DaemonConfigStore(path.join(root, `paseo-home-${stores}`), {
        mcp: { injectIntoAgents: false },
        browserTools: { enabled: false },
        providers: {},
        metadataGeneration: { providers: [] },
        autoArchiveAfterMerge: false,
        enableTerminalAgentHooks: false,
        appendSystemPrompt: "",
        pluginsEnabled,
        plugins: Object.fromEntries(
          Object.entries(plugins).map(([id, entry]) => [
            id,
            { source: "directory" as const, ...entry },
          ]),
        ),
      });
      return createOrchestrationSkills(
        configStore,
        loggerOverride ?? logger,
        () => targets,
        bundled,
      );
    },
  };
}

function installedCopies(targets: SkillTargets, name: string): Promise<(string | null)[]> {
  return Promise.all(
    [targets.agentsDir, targets.claudeDir, targets.codexDir].map((dir) =>
      readFile(path.join(dir, name, "SKILL.md"), "utf8").catch(() => null),
    ),
  );
}

describe("plugin skills: enabled plugins join the catalog", () => {
  it("installs the skills of an enabled configured plugin next to the core bundle", async () => {
    const harness = await makeHarness();
    const directory = await harness.plugin("reviewer", ["review-diff"]);

    const status = await harness
      .skills({ plugins: { reviewer: { path: directory } } })
      .autoUpdate();

    expect(status.available).toEqual(["alp", "review-diff"]);
    expect(status.state).toBe("up-to-date");
    expect(await installedCopies(harness.targets, "review-diff")).toEqual([
      "reviewer review-diff",
      "reviewer review-diff",
      "reviewer review-diff",
    ]);
    expect(await installedCopies(harness.targets, "alp")).toEqual([
      "core alp",
      "core alp",
      "core alp",
    ]);
  });

  it("installs the skills of a bundled plugin that has no config entry", async () => {
    const harness = await makeHarness();
    const directory = await harness.plugin("pack", ["pack-plan"], { skillsDir: "share/skills" });

    const status = await harness.skills({ bundled: { pack: directory } }).autoUpdate();

    expect(status.available).toEqual(["alp", "pack-plan"]);
    expect(await installedCopies(harness.targets, "pack-plan")).toEqual([
      "pack pack-plan",
      "pack pack-plan",
      "pack pack-plan",
    ]);
  });

  it.each([
    ["a config entry disables the bundled plugin", { disabledByEntry: true, global: true }],
    ["plugins are switched off globally", { disabledByEntry: false, global: false }],
  ])("leaves a plugin's skills out when %s", async (_label, { disabledByEntry, global }) => {
    const harness = await makeHarness();
    const directory = await harness.plugin("pack", ["pack-plan"]);

    const status = await harness
      .skills({
        pluginsEnabled: global,
        bundled: { pack: directory },
        plugins: disabledByEntry ? { pack: { path: directory, enabled: false } } : {},
      })
      .autoUpdate();

    expect(status.available).toEqual(["alp"]);
    expect(status.installed).toEqual(["alp"]);
    expect(await installedCopies(harness.targets, "pack-plan")).toEqual([null, null, null]);
  });
});

describe("plugin skills: a disabled plugin's skills stay managed", () => {
  it("offers to delete copies a now-disabled plugin installed, and deletes only when confirmed", async () => {
    const harness = await makeHarness();
    const directory = await harness.plugin("pack", ["pack-plan"]);
    await harness.skills({ bundled: { pack: directory } }).autoUpdate();

    const disabled = harness.skills({
      bundled: { pack: directory },
      plugins: { pack: { path: directory, enabled: false } },
    });
    const afterRestart = await disabled.autoUpdate();

    // Automatic maintenance never deletes: the copies stay until the user confirms.
    expect(await installedCopies(harness.targets, "pack-plan")).toEqual([
      "pack pack-plan",
      "pack pack-plan",
      "pack pack-plan",
    ]);
    expect(afterRestart.available).toEqual(["alp"]);
    expect(afterRestart.installed).toEqual(["alp", "pack-plan"]);
    expect(afterRestart.ops).toEqual([{ kind: "delete", name: "pack-plan" }]);

    const unconfirmed = await disabled.saveSelection({ mode: "all" });
    expect(unconfirmed.confirmationRequired).toEqual({ removals: ["pack-plan"] });
    expect(await installedCopies(harness.targets, "pack-plan")).toEqual([
      "pack pack-plan",
      "pack pack-plan",
      "pack pack-plan",
    ]);

    const confirmed = await disabled.saveSelection({ mode: "all" }, ["pack-plan"]);
    expect(confirmed.confirmationRequired).toBeNull();
    expect(confirmed.installed).toEqual(["alp"]);
    expect(await installedCopies(harness.targets, "pack-plan")).toEqual([null, null, null]);
  });

  it("keeps a bundled plugin's skills managed when a configured source replaces it", async () => {
    const harness = await makeHarness();
    const bundled = await harness.plugin("pack", ["pack-plan", "pack-review"]);
    await harness.skills({ bundled: { pack: bundled } }).autoUpdate();
    const fork = path.join(harness.root, "fork");
    await mkdir(fork, { recursive: true });
    await writeFile(
      path.join(fork, "paseo-plugin.json"),
      JSON.stringify({ id: "pack", skills: "skills" }),
    );
    await writeSkill(path.join(fork, "skills"), "pack-plan", "fork pack-plan");

    const status = await harness
      .skills({ bundled: { pack: bundled }, plugins: { pack: { path: fork } } })
      .autoUpdate();

    expect(status.available).toEqual(["alp", "pack-plan"]);
    expect(await installedCopies(harness.targets, "pack-plan")).toEqual([
      "fork pack-plan",
      "fork pack-plan",
      "fork pack-plan",
    ]);
    expect(status.ops).toEqual([{ kind: "delete", name: "pack-review" }]);
  });
});

describe("plugin skills: a name collision is logged, never thrown", () => {
  it("core keeps a name a plugin also ships; the plugin's other skills still install", async () => {
    const harness = await makeHarness();
    const directory = await harness.plugin("pack", ["alp", "pack-plan"]);
    const { logger: capture, messages } = collectErrorLogs();

    const status = await harness
      .skills({ plugins: { pack: { path: directory } }, logger: capture })
      .autoUpdate();

    expect(status.available).toEqual(["alp", "pack-plan"]);
    // Core's own copy, unreplaced — the plugin behaves as if it never shipped "alp".
    expect(await installedCopies(harness.targets, "alp")).toEqual([
      "core alp",
      "core alp",
      "core alp",
    ]);
    expect(await installedCopies(harness.targets, "pack-plan")).toEqual([
      "pack pack-plan",
      "pack pack-plan",
      "pack pack-plan",
    ]);
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      expect(message).toMatch(/"alp".*the core skills bundle.*plugin "pack"/);
    }
  });

  it("two enabled plugins sharing a name both lose it; each plugin's other skills still install", async () => {
    const harness = await makeHarness();
    const first = await harness.plugin("first", ["shared", "first-only"]);
    const second = await harness.plugin("second", ["shared", "second-only"]);
    const { logger: capture, messages } = collectErrorLogs();

    const status = await harness
      .skills({
        plugins: { first: { path: first }, second: { path: second } },
        logger: capture,
      })
      .autoUpdate();

    expect(status.available).toEqual(["alp", "first-only", "second-only"]);
    expect(await installedCopies(harness.targets, "shared")).toEqual([null, null, null]);
    expect(await installedCopies(harness.targets, "first-only")).toEqual([
      "first first-only",
      "first first-only",
      "first first-only",
    ]);
    expect(await installedCopies(harness.targets, "second-only")).toEqual([
      "second second-only",
      "second second-only",
      "second second-only",
    ]);
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      expect(message).toMatch(/"shared".*plugin "first".*plugin "second"/);
    }
  });

  it("a disabled plugin colliding with core blocks nothing: status, autoUpdate, and uninstall all succeed", async () => {
    const harness = await makeHarness();
    const directory = await harness.plugin("bad", ["alp"]);
    const { logger: capture, messages } = collectErrorLogs();
    const skills = harness.skills({
      plugins: { bad: { path: directory, enabled: false } },
      logger: capture,
    });

    await expect(skills.getStatus()).resolves.toMatchObject({ available: ["alp"] });
    const afterAutoUpdate = await skills.autoUpdate();
    expect(afterAutoUpdate.available).toEqual(["alp"]);
    expect(await installedCopies(harness.targets, "alp")).toEqual([
      "core alp",
      "core alp",
      "core alp",
    ]);
    await expect(skills.uninstall()).resolves.toMatchObject({ available: ["alp"] });
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) {
      expect(message).toMatch(/"alp".*the core skills bundle.*plugin "bad"/);
    }
  });
});
