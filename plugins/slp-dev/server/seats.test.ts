import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { readSeatSources, renderSeatsModule } from "./seats-source";

const pluginDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("seats.gen.ts matches agents/*.md and seats.json (run `npm run generate` after editing either)", async () => {
  const sources = await readSeatSources(pluginDirectory);
  const generated = await readFile(path.join(pluginDirectory, "server", "seats.gen.ts"), "utf8");
  expect(generated).toBe(renderSeatsModule(sources));
  expect(Object.keys(sources)).toEqual(["lead", "peer", "supervisor"]);
});

test("every skill a seat names ships in skills/", async () => {
  const sources = await readSeatSources(pluginDirectory);
  const shipped = (await readdir(path.join(pluginDirectory, "skills"))).filter(
    (name) => !name.startsWith("."),
  );
  for (const { skills } of Object.values(sources)) {
    for (const skill of skills) expect(shipped).toContain(skill);
  }
  expect(shipped.sort()).toEqual([
    "bug-loop",
    "goal-griller",
    "prompt-leverage",
    "sequence-execution-plan",
    "smart-commits",
    "xia",
  ]);
});
