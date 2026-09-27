import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonConfigStore, type MutableDaemonConfigPatch } from "../../daemon-config-store";
import { loadPersistedConfig } from "../../persisted-config";
import { createSkillSelectionStore } from "./selection-store";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createStore() {
  const root = await mkdtemp(path.join(os.tmpdir(), "alp-agent-skills-config-"));
  roots.push(root);
  const config = new DaemonConfigStore(root, {
    mcp: { injectIntoAgents: false },
    browserTools: { enabled: false },
    providers: {},
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
  });
  return { config, root, store: createSkillSelectionStore(config) };
}

describe("daemon agent skill selection", () => {
  it("defaults missing selection to all without persisting it", async () => {
    const { root, store } = await createStore();
    expect(await store.get()).toEqual({ mode: "all" });
    expect(await store.isSet()).toBe(false);
    expect(loadPersistedConfig(root).agents?.skills).toBeUndefined();
  });

  it("persists a normalized custom selection under agents.skills.selection", async () => {
    const { root, store } = await createStore();
    await store.set({ mode: "custom", skills: ["alp-loop", "alp", "alp"] });
    expect(loadPersistedConfig(root).agents?.skills?.selection).toEqual({
      mode: "custom",
      skills: ["alp", "alp-loop"],
    });
  });

  it("replaces a custom selection with all without retaining custom skill names", async () => {
    const { config, root, store } = await createStore();
    await store.set({ mode: "custom", skills: ["alp"] });

    await store.set({ mode: "all" });

    expect(config.get().skills?.selection).toEqual({ mode: "all" });
    expect(loadPersistedConfig(root).agents?.skills?.selection).toEqual({ mode: "all" });
  });

  it("does not expose selection through the generic config patch path", async () => {
    const { config, root, store } = await createStore();

    config.patch({
      skills: { selection: { mode: "custom", skills: ["alp"] } },
    } as MutableDaemonConfigPatch);

    expect(await store.isSet()).toBe(false);
    expect(loadPersistedConfig(root).agents?.skills).toBeUndefined();
  });
});

// ALP(rebrand): selections saved before the alp* skills were renamed to alp*.
describe("renamed skills in a saved selection", () => {
  it("reads old skill names as their new names without rewriting the config", async () => {
    const { root, store } = await createStore();
    await store.set({ mode: "custom", skills: ["paseo", "paseo-help", "xia"] }); // alp-rename-keep

    expect(await store.get()).toEqual({ mode: "custom", skills: ["alp", "alp-help", "xia"] });
    expect(loadPersistedConfig(root).agents?.skills?.selection).toEqual({
      mode: "custom",
      skills: ["paseo", "paseo-help", "xia"], // alp-rename-keep
    });
  });

  it("maps every renamed skill and merges an old name with its new one", async () => {
    const { store } = await createStore();
    await store.set({
      mode: "custom",
      skills: [
        "paseo", // alp-rename-keep
        "paseo-advisor", // alp-rename-keep
        "paseo-committee", // alp-rename-keep
        "paseo-handoff", // alp-rename-keep
        "paseo-help", // alp-rename-keep
        "paseo-plugin", // alp-rename-keep
        "alp",
      ],
    });

    expect(await store.get()).toEqual({
      mode: "custom",
      skills: ["alp", "alp-advisor", "alp-committee", "alp-handoff", "alp-help", "alp-plugin"],
    });
  });

  it("leaves names outside the rename table and the all mode unchanged", async () => {
    const { store } = await createStore();
    // alp-rename-keep-start
    await store.set({ mode: "custom", skills: ["paseo-chat", "paseo-loop", "xia"] });
    // alp-rename-keep-end
    expect(await store.get()).toEqual({
      mode: "custom",
      skills: ["paseo-chat", "paseo-loop", "xia"], // alp-rename-keep
    });

    await store.set({ mode: "all" });
    expect(await store.get()).toEqual({ mode: "all" });
  });
});
