import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import pino from "pino";
import { assertPluginCompatibility } from "@alp/protocol/plugin-requirements";
import { pluginSkillsInstallable, readPluginManifest, resolvePluginSkillsDir } from "./manifest.js";
import { PluginRuntime } from "./runtime.js";

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

  describe("a plugin written for upstream Paseo", () => {
    async function createUpstreamPlugin(manifestFile: string, range: string): Promise<string> {
      const directory = await mkdtemp(path.join(tmpdir(), "alp-plugin-upstream-"));
      directories.push(directory);
      await writeFile(
        path.join(directory, manifestFile),
        JSON.stringify({ id: "upstream", requirements: { paseo: range } }),
      );
      await writeFile(
        path.join(directory, "index.server.ts"),
        `import type { PluginServerContext } from "@getpaseo/plugin/server";
export default function contribute(context: PluginServerContext) { return () => void context; }`,
      );
      return directory;
    }

    function validate(directory: string): Promise<void> {
      return new PluginRuntime(pino({ level: "silent" }), "1.0.0").validatePlugin(directory);
    }

    it("loads when requirements.paseo matches the upstream base", async () => {
      const directory = await createUpstreamPlugin("paseo-plugin.json", ">=0.9.1 <0.10.0");
      await expect(validate(directory)).resolves.toBeUndefined();
    });

    it("rejects requirements.paseo that excludes the upstream base", async () => {
      const directory = await createUpstreamPlugin("paseo-plugin.json", ">=0.10.0");
      await expect(validate(directory)).rejects.toThrow(
        'Plugin "upstream" requires Paseo >=0.10.0 (requirements.paseo in paseo-plugin.json), but this alp is built on Paseo 0.9.2.',
      );
    });

    it("rejects an invalid requirements.paseo range", async () => {
      const directory = await createUpstreamPlugin("paseo-plugin.json", "latest");
      await expect(validate(directory)).rejects.toThrow(
        'Invalid requirements.paseo in paseo-plugin.json: "latest".',
      );
    });

    async function publishClientPlugin(
      manifestFile: string,
      requirements: Record<string, string>,
    ): Promise<ReturnType<PluginRuntime["catalog"]>> {
      const directory = await mkdtemp(path.join(tmpdir(), "alp-plugin-upstream-client-"));
      directories.push(directory);
      await writeFile(
        path.join(directory, manifestFile),
        JSON.stringify({ id: "upstream", requirements }),
      );
      await writeFile(
        path.join(directory, "index.client.tsx"),
        `import type { PluginClientContext } from "@getpaseo/plugin/client";
export default function contribute(client: PluginClientContext) { return () => void client; }`,
      );
      const runtime = new PluginRuntime(pino({ level: "silent" }), "1.0.0");
      await runtime.startPlugin("upstream", directory);
      const catalog = runtime.catalog();
      await runtime.stopAll();
      return catalog;
    }

    it("publishes an alp range the app accepts for a legacy manifest", async () => {
      const [entry] = await publishClientPlugin("paseo-plugin.json", { paseo: ">=0.9.1 <0.10.0" });

      expect(entry.requirements).toEqual({ alp: ">=1.0.0" });
      // Throws, failing the test, when the app would refuse the plugin.
      assertPluginCompatibility({ ...entry, version: "1.0.0", runtime: "app" });
    });

    it("publishes requirements.alp as declared", async () => {
      const [entry] = await publishClientPlugin("alp-plugin.json", { alp: ">=0.8.0" });

      expect(entry.requirements).toEqual({ alp: ">=0.8.0" });
    });

    it("rejects requirements.paseo in alp-plugin.json", async () => {
      const directory = await createUpstreamPlugin("alp-plugin.json", ">=0.9.1 <0.10.0");
      await expect(validate(directory)).rejects.toThrow(/Unrecognized key.*paseo/);
    });
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
