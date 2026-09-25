import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDefinitionSources, renderDefinitionsModule } from "../definitions-source.ts";

const serverDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sources = await readDefinitionSources(path.join(serverDirectory, "..", "agents"));
await writeFile(path.join(serverDirectory, "definitions.gen.ts"), renderDefinitionsModule(sources));
