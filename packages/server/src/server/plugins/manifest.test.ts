import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { pluginSkillsInstallable, readPluginManifest, resolvePluginSkillsDir } from "./manifest.js";

const directories: string[] = [];
const examplesDirectory = fileURLToPath(
  new URL("../../../../../plugin-examples/", import.meta.url),
);
const examples = (await readdir(examplesDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("plugin manifest", () => {
  it.each(examples)("validates the %s example manifest", async (name) => {
    await expect(readPluginManifest(path.join(examplesDirectory, name))).resolves.toMatchObject({
      id: expect.any(String),
    });
  });

  it("reads and validates requirements before any plugin code runs", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "alp-plugin-manifest-"));
    directories.push(directory);
    const manifest = path.join(directory, "alp-plugin.json");
    await writeFile(manifest, JSON.stringify({ id: "example", requirements: { alp: "^0.8.0" } }));
    await expect(readPluginManifest(directory)).resolves.toEqual({
      id: "example",
      requirements: { alp: "^0.8.0" },
    });
    for (const requirements of [
      { alp: "latest" },
      { alp: "" },
      { alp: 8 },
      { node: ">=20" },
      "0.8.0",
    ]) {
      await writeFile(manifest, JSON.stringify({ id: "example", requirements }));
      await expect(readPluginManifest(directory)).rejects.toThrow();
    }
  });

  // alp-rename-keep-start: COMPAT(paseo-plugin-manifest) reads manifests written for upstream Paseo.
  it("reads paseo-plugin.json when the plugin has no alp-plugin.json", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "alp-plugin-manifest-"));
    directories.push(directory);
    await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id: "upstream" }));

    await expect(readPluginManifest(directory)).resolves.toEqual({ id: "upstream" });
  });

  it("prefers alp-plugin.json over paseo-plugin.json", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "alp-plugin-manifest-"));
    directories.push(directory);
    await writeFile(path.join(directory, "paseo-plugin.json"), JSON.stringify({ id: "upstream" }));
    await writeFile(path.join(directory, "alp-plugin.json"), JSON.stringify({ id: "fork" }));

    await expect(readPluginManifest(directory)).resolves.toEqual({ id: "fork" });
  });
  // alp-rename-keep-end

  it("names alp-plugin.json when the plugin has no manifest", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "alp-plugin-manifest-"));
    directories.push(directory);

    await expect(readPluginManifest(directory)).rejects.toThrow(
      `Plugin manifest is missing: ${path.join(directory, "alp-plugin.json")}`,
    );
  });

  it("reads an optional description", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "alp-plugin-manifest-"));
    directories.push(directory);
    await writeFile(
      path.join(directory, "alp-plugin.json"),
      JSON.stringify({ id: "described", description: "Reviews changes before merge" }),
    );

    await expect(readPluginManifest(directory)).resolves.toEqual({
      id: "described",
      description: "Reviews changes before merge",
    });

    await writeFile(
      path.join(directory, "alp-plugin.json"),
      JSON.stringify({ id: "described", description: "   " }),
    );
    await expect(readPluginManifest(directory)).rejects.toThrow();
  });

  it("reads an optional skills directory relative to the plugin root", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "alp-plugin-manifest-"));
    directories.push(directory);
    const manifest = path.join(directory, "alp-plugin.json");

    for (const skills of ["skills", "./share/skills", "share/skills/"]) {
      await writeFile(manifest, JSON.stringify({ id: "skilled", skills }));
      await expect(readPluginManifest(directory)).resolves.toEqual({ id: "skilled", skills });
    }

    for (const skills of [
      "",
      "   ",
      ".",
      "..",
      "../skills",
      "skills/../../x",
      "/abs/skills",
      "D:skills",
      "c:x",
      7,
    ]) {
      await writeFile(manifest, JSON.stringify({ id: "skilled", skills }));
      await expect(readPluginManifest(directory)).rejects.toThrow();
    }
  });

  it("accepts an object skills form only to say install: false", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "alp-plugin-manifest-"));
    directories.push(directory);
    const manifest = path.join(directory, "alp-plugin.json");

    const skills = { dir: "share/skills", install: false };
    await writeFile(manifest, JSON.stringify({ id: "skilled", skills }));
    await expect(readPluginManifest(directory)).resolves.toEqual({ id: "skilled", skills });

    for (const badSkills of [
      { dir: "skills" },
      { dir: "skills", install: true },
      { install: false },
      { dir: "../skills", install: false },
      { dir: "skills", install: false, extra: true },
      { dir: 7, install: false },
    ]) {
      await writeFile(manifest, JSON.stringify({ id: "skilled", skills: badSkills }));
      await expect(readPluginManifest(directory)).rejects.toThrow();
    }
  });

  it("resolves the skills dir and installability for both the string and object forms", () => {
    const stringForm = { id: "skilled", skills: "skills" } as const;
    expect(resolvePluginSkillsDir("/plugin", stringForm)).toBe(path.resolve("/plugin", "skills"));
    expect(pluginSkillsInstallable(stringForm)).toBe(true);

    const objectForm = { id: "skilled", skills: { dir: "skills", install: false as const } };
    expect(resolvePluginSkillsDir("/plugin", objectForm)).toBe(path.resolve("/plugin", "skills"));
    expect(pluginSkillsInstallable(objectForm)).toBe(false);

    const noSkills = { id: "bare" };
    expect(resolvePluginSkillsDir("/plugin", noSkills)).toBeNull();
  });

  it("accepts only non-empty argv arrays for build commands", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "alp-plugin-manifest-"));
    directories.push(directory);
    const manifest = path.join(directory, "alp-plugin.json");

    await writeFile(
      manifest,
      JSON.stringify({ id: "prepared", build: [["pnpm", "install", "--frozen-lockfile"]] }),
    );
    await expect(readPluginManifest(directory)).resolves.toMatchObject({
      build: [["pnpm", "install", "--frozen-lockfile"]],
    });

    for (const build of [[], [[]], [["pnpm", ""]], [["pnpm", 1]], "pnpm install"]) {
      await writeFile(manifest, JSON.stringify({ id: "prepared", build }));
      await expect(readPluginManifest(directory)).rejects.toThrow();
    }
  });
});
