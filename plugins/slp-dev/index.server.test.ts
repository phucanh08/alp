import type { PluginRpcContract } from "@alp/plugin";
import type { PluginServerContext } from "@alp/plugin/server";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { type z, ZodError } from "zod";
import contribute from "./index.server";
import { slpDevSeatGet, slpDevSkillsGet } from "./shared/rpc";

const pluginDirectory = path.dirname(fileURLToPath(import.meta.url));

type RpcHandler = (input: unknown, context: { alp: unknown }) => unknown;

/**
 * Registers the plugin against a fake `PluginServerContext` and calls one of its RPCs the way the
 * plugin subprocess does: parse the input with the contract, run the handler, parse the output.
 */
function invoke<Contract extends typeof slpDevSeatGet | typeof slpDevSkillsGet>(
  contract: Contract,
  input: unknown,
) {
  const handlers = new Map<string, RpcHandler>();
  const server = {
    handle: (registered: PluginRpcContract, handler: RpcHandler) => {
      handlers.set(registered.name, handler);
    },
  } as unknown as PluginServerContext;
  contribute(server);
  const handler = handlers.get(contract.name);
  if (!handler) throw new Error(`${contract.name} is not registered`);
  return contract.input
    .parseAsync(input)
    .then((parsed) => handler(parsed, { alp: {} }))
    .then((output) => contract.output.parseAsync(output) as Promise<z.output<Contract["output"]>>);
}

function seatGet(input: unknown) {
  return invoke(slpDevSeatGet, input);
}

function seatFile(seat: string): Promise<string> {
  return readFile(path.join(pluginDirectory, "agents", `${seat}.md`), "utf8");
}

test("slp-dev.seat.get answers the lead seat with its rule file and all six skills", async () => {
  expect(await seatGet({ seat: "lead" })).toEqual({
    definition: await seatFile("lead"),
    skills: [
      "bug-loop",
      "goal-griller",
      "prompt-leverage",
      "sequence-execution-plan",
      "smart-commits",
      "xia",
    ],
  });
});

test("slp-dev.seat.get answers the peer seat with its rule file and three skills", async () => {
  expect(await seatGet({ seat: "peer" })).toEqual({
    definition: await seatFile("peer"),
    skills: ["xia", "smart-commits", "bug-loop"],
  });
});

test("slp-dev.seat.get answers the supervisor seat with its rule file and no skills", async () => {
  expect(await seatGet({ seat: "supervisor" })).toEqual({
    definition: await seatFile("supervisor"),
    skills: [],
  });
});

test("slp-dev.seat.get rejects a seat it does not know", async () => {
  await expect(seatGet({ seat: "reviewer" })).rejects.toBeInstanceOf(ZodError);
  await expect(seatGet({})).rejects.toBeInstanceOf(ZodError);
});

/** Every file under `skills/<skill>/` for the given skills, as `<skill>/<relative path>`. */
async function shippedSkillFiles(skills: string[]) {
  const files: Array<{ path: string; content: string; executable: boolean }> = [];
  for (const skill of skills) {
    const root = path.join(pluginDirectory, "skills", skill);
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const absolute = path.join(entry.parentPath, entry.name);
      files.push({
        path: `${skill}/${path.relative(root, absolute).split(path.sep).join("/")}`,
        content: await readFile(absolute, "utf8"),
        executable: ((await stat(absolute)).mode & 0o100) !== 0,
      });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function skillsGet(input: unknown) {
  return invoke(slpDevSkillsGet, input);
}

test("slp-dev.skills.get answers the lead seat with every file of its six skills, verbatim", async () => {
  const { files } = await skillsGet({ seat: "lead" });
  const expected = await shippedSkillFiles([
    "bug-loop",
    "goal-griller",
    "prompt-leverage",
    "sequence-execution-plan",
    "smart-commits",
    "xia",
  ]);
  expect([...files].sort((a, b) => a.path.localeCompare(b.path))).toEqual(expected);
  expect(files).toContainEqual(
    expect.objectContaining({ path: "bug-loop/scripts/hitl-loop.template.sh", executable: true }),
  );
  expect(files).toContainEqual(
    expect.objectContaining({ path: "xia/SKILL.md", executable: false }),
  );
});

test("slp-dev.skills.get answers the peer seat with its three skills' files only", async () => {
  const { files } = await skillsGet({ seat: "peer" });
  expect([...files].sort((a, b) => a.path.localeCompare(b.path))).toEqual(
    await shippedSkillFiles(["bug-loop", "smart-commits", "xia"]),
  );
  expect(files.some((file) => file.path.startsWith("goal-griller/"))).toBe(false);
});

test("slp-dev.skills.get answers the supervisor seat with no files", async () => {
  expect(await skillsGet({ seat: "supervisor" })).toEqual({ files: [] });
  await expect(skillsGet({ seat: "reviewer" })).rejects.toBeInstanceOf(ZodError);
});
