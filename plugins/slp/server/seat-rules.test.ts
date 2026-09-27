import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import contributeSlpDev from "../../slp-dev/index.server";
import { slpDevSeatGet } from "../../slp-dev/shared/rpc";
import type { AgentLister } from "./discovery";
import { withSeatConfig } from "./hooks";
import { readSeatRules, SLP_DEV_PLUGIN_ID, SLP_DEV_SEAT_GET } from "./seat-rules";

const slpDevDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "slp-dev",
);

const noAgents: AgentLister = {
  async list() {
    return { entries: [], pageInfo: { nextCursor: null } };
  },
};

/** `paseo.plugins` backed by slp-dev's own `seat.get` handler, validated like the daemon does. */
function realSlpDev() {
  let handler: ((input: unknown, context: unknown) => unknown) | undefined;
  contributeSlpDev({
    handle: (contract: { name: string }, registered: typeof handler) => {
      if (contract.name === slpDevSeatGet.name) handler = registered;
    },
  } as never);
  return {
    async invoke(pluginId: string, method: string, input: unknown) {
      const manifest = JSON.parse(
        await readFile(path.join(slpDevDirectory, "paseo-plugin.json"), "utf8"),
      );
      if (pluginId !== manifest.id || method !== slpDevSeatGet.name || !handler)
        throw new Error("Plugin is not available");
      return slpDevSeatGet.output.parse(await handler(slpDevSeatGet.input.parse(input), {}));
    },
  };
}

test("slp addresses slp-dev's seat.get by slp-dev's own plugin id and method name", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(slpDevDirectory, "paseo-plugin.json"), "utf8"),
  );
  expect(SLP_DEV_PLUGIN_ID).toBe(manifest.id);
  expect(SLP_DEV_SEAT_GET).toBe(slpDevSeatGet.name);
});

test("with slp-dev's real seat.get, each seat gets agents/<seat>.md minus frontmatter and the seats.json skills", async () => {
  const seats = JSON.parse(
    await readFile(path.join(slpDevDirectory, "seats.json"), "utf8"),
  ) as Record<"lead" | "peer" | "supervisor", string[]>;
  for (const seat of ["lead", "peer", "supervisor"] as const) {
    const file = await readFile(path.join(slpDevDirectory, "agents", `${seat}.md`), "utf8");
    expect(file.startsWith(`---\nname: ${seat}\n`)).toBe(true);
    const body = file.slice(file.indexOf("\n---\n", 4) + "\n---\n".length).trim();
    const result = (await withSeatConfig(
      {
        config: { provider: "claude", cwd: "/nonexistent-slp-cwd" },
        labels: { "slp.role": seat },
      } as never,
      { agents: noAgents, plugins: realSlpDev() },
    )) as { config: { systemPrompt: string } } | undefined;
    const prompt = result?.config.systemPrompt ?? "";
    expect(prompt.startsWith(`# Ghế SLP: ${seat}\n\n${body}\n\n## SLP-RUNTIME: alp\n`)).toBe(true);
    const skills = seats[seat].map((skill) => `\`${skill}\``).join(", ");
    if (seats[seat].length > 0)
      expect(prompt).toContain(`- **Skill của ghế này** (plugin \`slp-dev\`): ${skills}.`);
    else expect(prompt).not.toContain("Skill của ghế này");
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test("readSeatRules leaves no timer behind once slp-dev answers or fails", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await readSeatRules("/nonexistent-slp-cwd", "peer", realSlpDev());
  expect(vi.getTimerCount()).toBe(0);
  await readSeatRules("/nonexistent-slp-cwd", "peer", {
    invoke: async () => {
      throw new Error("Plugin is not available");
    },
  });
  expect(vi.getTimerCount()).toBe(0);
});
