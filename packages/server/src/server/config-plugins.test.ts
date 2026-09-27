import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { loadConfig } from "./config.js";

const roots: string[] = [];

async function createAlpHome(config: unknown): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "alp-config-plugins-"));
  roots.push(root);
  const alpHome = path.join(root, ".alp");
  await mkdir(alpHome, { recursive: true });
  await writeFile(path.join(alpHome, "config.json"), JSON.stringify(config, null, 2));
  return alpHome;
}

describe("daemon plugin config", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  // ALP(slp): alp turns plugins on for any config that never set the key (Human ruling, P6).
  test("turns plugins on at daemon start when the config never set them", async () => {
    const home = await createAlpHome({ version: 1 });

    expect(loadConfig(home, { env: {} }).pluginsEnabled).toBe(true);
    const onDisk = JSON.parse(await readFile(path.join(home, "config.json"), "utf8"));
    expect(onDisk.pluginsEnabled).toBe(true);
    expect(onDisk.agents).toBeUndefined();
  });

  test("keeps plugins off when the user turned them off", async () => {
    const home = await createAlpHome({ version: 1, pluginsEnabled: false });

    expect(loadConfig(home, { env: {} }).pluginsEnabled).toBe(false);
  });

  test("loads the explicit plugin opt-in", async () => {
    const home = await createAlpHome({ version: 1, pluginsEnabled: true });

    expect(loadConfig(home, { env: {} }).pluginsEnabled).toBe(true);
  });
});
