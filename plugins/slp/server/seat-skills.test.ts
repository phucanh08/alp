import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import contributeSlpDev from "../../slp-dev/index.server";
import { slpDevSkillsGet } from "../../slp-dev/shared/rpc";
import { createSeatSkills, SLP_DEV_SKILLS_GET, seatSkillsRoot } from "./seat-skills";

const slpDevSkillsDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "slp-dev",
  "skills",
);

afterEach(() => {
  vi.restoreAllMocks();
});

/** `paseo.plugins` backed by slp-dev's own `skills.get` handler, validated like the daemon does. */
function realSlpDev() {
  let handler: ((input: unknown, context: unknown) => unknown) | undefined;
  contributeSlpDev({
    handle: (contract: { name: string }, registered: typeof handler) => {
      if (contract.name === slpDevSkillsGet.name) handler = registered;
    },
  } as never);
  return {
    async invoke(pluginId: string, method: string, input: unknown) {
      if (pluginId !== "slp-dev" || method !== slpDevSkillsGet.name || !handler)
        throw new Error("Plugin is not available");
      return slpDevSkillsGet.output.parse(await handler(slpDevSkillsGet.input.parse(input), {}));
    },
  };
}

type Files = Array<{ path: string; content: string; executable: boolean }>;

/** A fake slp-dev whose `skills.get` answers `files[seat]`; records every call. */
function fakeSlpDev(files: Record<string, Files>) {
  const calls: Array<{ method: string; input: unknown }> = [];
  return {
    calls,
    files,
    async invoke(_pluginId: string, method: string, input: unknown) {
      calls.push({ method, input });
      return { files: files[(input as { seat: string }).seat] ?? [] };
    },
  };
}

async function temporaryHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "slp-seat-skills-"));
}

/** Relative paths of every file under `directory`, sorted, `/`-separated. */
async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"),
    )
    .sort();
}

test("slp addresses slp-dev's skills.get by its contract name", () => {
  expect(SLP_DEV_SKILLS_GET).toBe(slpDevSkillsGet.name);
});

test("the seat skills root is $PASEO_HOME/slp/seat-skills, and there is none without PASEO_HOME", () => {
  expect(seatSkillsRoot({ PASEO_HOME: "/srv/alp" }, "/home/u")).toBe("/srv/alp/slp/seat-skills");
  expect(seatSkillsRoot({ PASEO_HOME: "~/dev-home" }, "/home/u")).toBe(
    "/home/u/dev-home/slp/seat-skills",
  );
  expect(seatSkillsRoot({}, "/home/u")).toBeNull();
  expect(seatSkillsRoot({ PASEO_HOME: "" }, "/home/u")).toBeNull();
});

test("the lead seat directory is a Claude local plugin `slp-lead` holding the six lead skills byte for byte", async () => {
  const home = await temporaryHome();
  const root = path.join(home, "slp", "seat-skills");
  const directory = await createSeatSkills(root).ensure("lead", realSlpDev());

  expect(directory).toBe(path.join(home, "slp", "seat-skills", "lead"));
  expect(
    JSON.parse(await readFile(path.join(directory!, ".claude-plugin", "plugin.json"), "utf8")),
  ).toMatchObject({ name: "slp-lead" });
  expect((await readdir(path.join(directory!, "skills"))).sort()).toEqual([
    "bug-loop",
    "goal-griller",
    "prompt-leverage",
    "sequence-execution-plan",
    "smart-commits",
    "xia",
  ]);
  for (const skill of await readdir(path.join(directory!, "skills"))) {
    const shipped = path.join(slpDevSkillsDirectory, skill);
    const written = path.join(directory!, "skills", skill);
    const files = await filesUnder(shipped);
    expect(await filesUnder(written)).toEqual(files);
    for (const file of files) {
      const source = await readFile(path.join(shipped, file));
      const copy = await readFile(path.join(written, file));
      expect(copy.equals(source), `${skill}/${file}`).toBe(true);
      expect((await stat(path.join(written, file))).mode & 0o100).toBe(
        (await stat(path.join(shipped, file))).mode & 0o100,
      );
    }
  }
});

test("the peer seat directory is `slp-peer` with exactly the three peer skills", async () => {
  const home = await temporaryHome();
  const directory = await createSeatSkills(path.join(home, "slp", "seat-skills")).ensure(
    "peer",
    realSlpDev(),
  );

  expect(directory).toBe(path.join(home, "slp", "seat-skills", "peer"));
  expect(
    JSON.parse(await readFile(path.join(directory!, ".claude-plugin", "plugin.json"), "utf8")),
  ).toMatchObject({ name: "slp-peer" });
  expect((await readdir(path.join(directory!, "skills"))).sort()).toEqual([
    "bug-loop",
    "smart-commits",
    "xia",
  ]);
});

test("a seat with no skills gets no directory, and an old one is removed", async () => {
  const root = path.join(await temporaryHome(), "slp", "seat-skills");
  await mkdir(path.join(root, "supervisor", "skills", "xia"), { recursive: true });

  expect(await createSeatSkills(root).ensure("supervisor", realSlpDev())).toBeNull();
  expect(await readdir(root)).toEqual([]);
});

test("the seat directory is rebuilt only when its content changes, and stale skills go", async () => {
  const root = path.join(await temporaryHome(), "slp", "seat-skills");
  const slpDev = fakeSlpDev({
    lead: [
      { path: "alpha/SKILL.md", content: "ALPHA v1\n", executable: false },
      { path: "beta/SKILL.md", content: "BETA\n", executable: false },
    ],
  });
  const seatSkills = createSeatSkills(root);
  const directory = (await seatSkills.ensure("lead", slpDev))!;
  const marker = path.join(directory, "skills", "alpha", "untouched");
  await writeFile(marker, "");

  expect(await seatSkills.ensure("lead", slpDev)).toBe(directory);
  expect(await createSeatSkills(root).ensure("lead", slpDev)).toBe(directory);
  expect(await filesUnder(path.join(directory, "skills"))).toEqual([
    "alpha/SKILL.md",
    "alpha/untouched",
    "beta/SKILL.md",
  ]);

  slpDev.files.lead = [
    { path: "alpha/SKILL.md", content: "ALPHA v2\n", executable: false },
    { path: "gamma/run.sh", content: "#!/bin/sh\n", executable: true },
  ];
  expect(await seatSkills.ensure("lead", slpDev)).toBe(directory);
  expect(await filesUnder(path.join(directory, "skills"))).toEqual([
    "alpha/SKILL.md",
    "gamma/run.sh",
  ]);
  expect(await readFile(path.join(directory, "skills", "alpha", "SKILL.md"), "utf8")).toBe(
    "ALPHA v2\n",
  );
  expect((await stat(path.join(directory, "skills", "gamma", "run.sh"))).mode & 0o100).toBe(0o100);
  expect((await readdir(root)).sort()).toEqual(["lead"]);
});

test("ensureAll keeps one directory per seat with skills and removes anything else in the root", async () => {
  const root = path.join(await temporaryHome(), "slp", "seat-skills");
  await mkdir(path.join(root, "reviewer", "skills"), { recursive: true });
  await mkdir(path.join(root, ".lead-leftover"), { recursive: true });
  await mkdir(path.join(root, "supervisor"), { recursive: true });

  await createSeatSkills(root).ensureAll(realSlpDev());

  expect((await readdir(root)).sort()).toEqual(["lead", "peer"]);
});

test("slp-dev failing, answering garbage, or a path escaping the directory leaves the seat without skills", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const root = path.join(await temporaryHome(), "slp", "seat-skills");
  const failing = {
    async invoke(): Promise<unknown> {
      throw new Error("Plugin is not available");
    },
  };
  const garbage = {
    async invoke(): Promise<unknown> {
      return { definition: "x", skills: [] };
    },
  };
  const escaping = fakeSlpDev({
    lead: [{ path: "../../escape/SKILL.md", content: "X", executable: false }],
  });

  const seatSkills = createSeatSkills(root);
  expect(await seatSkills.ensure("lead", failing)).toBeNull();
  expect(await seatSkills.ensure("lead", garbage)).toBeNull();
  expect(await seatSkills.ensure("lead", escaping)).toBeNull();
  await expect(stat(path.join(root, "..", "escape"))).rejects.toThrow();
});

test("without a root nothing is asked or written", async () => {
  const slpDev = fakeSlpDev({ lead: [{ path: "a/SKILL.md", content: "A", executable: false }] });
  expect(await createSeatSkills(null).ensure("lead", slpDev)).toBeNull();
  await createSeatSkills(null).ensureAll(slpDev);
  expect(slpDev.calls).toEqual([]);
});
