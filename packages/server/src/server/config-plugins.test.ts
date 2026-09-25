import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadConfig } from "./config.js";

const roots: string[] = [];

async function createPaseoHome(config: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-config-plugins-"));
  roots.push(root);
  const paseoHome = path.join(root, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  await writeFile(path.join(paseoHome, "config.json"), JSON.stringify(config, null, 2));
  return paseoHome;
}

describe("daemon plugin config", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  // ALP(slp): alp turns plugins on for any config that never set the key (Human ruling, P6).
  test("turns plugins on at daemon start when the config never set them", async () => {
    const home = await createPaseoHome({ version: 1 });

    expect(loadConfig(home, { env: {} }).pluginsEnabled).toBe(true);
    const onDisk = JSON.parse(await readFile(path.join(home, "config.json"), "utf8"));
    expect(onDisk.pluginsEnabled).toBe(true);
    expect(Object.keys(onDisk.agents.providers)).toEqual([
      "claude-lead",
      "claude-peer",
      "claude-supervisor",
      "codex-lead",
      "codex-peer",
      "codex-supervisor",
    ]);
  });

  test("keeps plugins off when the user turned them off", async () => {
    const home = await createPaseoHome({ version: 1, pluginsEnabled: false });

    expect(loadConfig(home, { env: {} }).pluginsEnabled).toBe(false);
  });

  test("loads the explicit plugin opt-in", async () => {
    const home = await createPaseoHome({ version: 1, pluginsEnabled: true });

    expect(loadConfig(home, { env: {} }).pluginsEnabled).toBe(true);
  });
});
