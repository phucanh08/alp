import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { readDefinitionSources, renderDefinitionsModule } from "./definitions-source";

const serverDirectory = path.dirname(fileURLToPath(import.meta.url));

test("definitions.gen.ts matches agents/*.md (run `npm run generate` after editing a seat)", async () => {
  const sources = await readDefinitionSources(path.join(serverDirectory, "..", "agents"));
  const generated = await readFile(path.join(serverDirectory, "definitions.gen.ts"), "utf8");
  expect(generated).toBe(renderDefinitionsModule(sources));
  expect(sources.lead.startsWith("---\nname: lead\n")).toBe(true);
  expect(sources.peer.startsWith("---\nname: peer\n")).toBe(true);
  expect(sources.supervisor.startsWith("---\nname: supervisor\n")).toBe(true);
});
