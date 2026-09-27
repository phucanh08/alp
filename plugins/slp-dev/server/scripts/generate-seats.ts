import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSeatSources, renderSeatsModule } from "../seats-source.ts";

const serverDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sources = await readSeatSources(path.join(serverDirectory, ".."));
await writeFile(path.join(serverDirectory, "seats.gen.ts"), renderSeatsModule(sources));
