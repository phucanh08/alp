import type { PluginRpcContract } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { ZodError } from "zod";
import contribute from "./index.server";
import { slpDevSeatGet } from "./shared/rpc";

const pluginDirectory = path.dirname(fileURLToPath(import.meta.url));

type RpcHandler = (input: unknown, context: { paseo: unknown }) => unknown;

/**
 * Registers the plugin against a fake `PluginServerContext` and calls `slp-dev.seat.get` the way
 * the plugin subprocess does: parse the input with the contract, run the handler, parse the output.
 */
function seatGet(input: unknown) {
  const handlers = new Map<string, RpcHandler>();
  const server = {
    handle: (contract: PluginRpcContract, handler: RpcHandler) => {
      handlers.set(contract.name, handler);
    },
  } as unknown as PluginServerContext;
  contribute(server);
  const handler = handlers.get(slpDevSeatGet.name);
  if (!handler) throw new Error(`${slpDevSeatGet.name} is not registered`);
  return slpDevSeatGet.input
    .parseAsync(input)
    .then((parsed) => handler(parsed, { paseo: {} }))
    .then((output) => slpDevSeatGet.output.parseAsync(output));
}

function seatFile(seat: string): Promise<string> {
  return readFile(path.join(pluginDirectory, "agents", `${seat}.md`), "utf8");
}

test("slp-dev.seat.get answers the lead seat with its rule file and all seven skills", async () => {
  expect(await seatGet({ seat: "lead" })).toEqual({
    definition: await seatFile("lead"),
    skills: [
      "ask-alp",
      "bug-loop",
      "goal-griller",
      "prompt-leverage",
      "sequence-execution-plan",
      "smart-commits",
      "xia",
    ],
  });
});

test("slp-dev.seat.get answers the peer seat with its rule file and four skills", async () => {
  expect(await seatGet({ seat: "peer" })).toEqual({
    definition: await seatFile("peer"),
    skills: ["xia", "smart-commits", "bug-loop", "ask-alp"],
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
