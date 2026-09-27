import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readSeatSources,
  readSkillSources,
  renderSeatsModule,
  renderSkillsModule,
} from "../seats-source.ts";

const serverDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pluginDirectory = path.join(serverDirectory, "..");
const sources = await readSeatSources(pluginDirectory);
await writeFile(path.join(serverDirectory, "seats.gen.ts"), renderSeatsModule(sources));
const skills = await readSkillSources(pluginDirectory);
await writeFile(path.join(serverDirectory, "skills.gen.ts"), renderSkillsModule(skills));
