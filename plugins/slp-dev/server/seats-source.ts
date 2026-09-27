import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

/**
 * Seat content shipped with the plugin: `agents/<seat>.md` is a seat's rule text and `seats.json`
 * maps each seat to its skills. `seats.gen.ts` embeds both because the plugin compiler bundles
 * `server/` into one string that the daemon evaluates: at runtime the plugin has no path to its own
 * directory, and esbuild has no loader for `.md`. `skills.gen.ts` embeds `skills/` for the same reason.
 */
export type SeatSources = Record<string, { definition: string; skills: string[] }>;

export async function readSeatSources(pluginDirectory: string): Promise<SeatSources> {
  const map = JSON.parse(
    await readFile(path.join(pluginDirectory, "seats.json"), "utf8"),
  ) as Record<string, string[]>;
  const entries = await Promise.all(
    Object.entries(map).map(async ([seat, skills]) => {
      const definition = await readFile(path.join(pluginDirectory, "agents", `${seat}.md`), "utf8");
      return [seat, { definition, skills }] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export function renderSeatsModule(sources: SeatSources): string {
  const rows = Object.entries(sources).map(
    ([seat, { definition, skills }]) =>
      `  ${seat}: { definition: ${JSON.stringify(definition)}, skills: ${JSON.stringify(skills)} },`,
  );
  return [
    "// Generated from agents/*.md and seats.json by `npm run generate` (server/scripts/generate-seats.ts).",
    "// Do not edit by hand: edit agents/<seat>.md or seats.json and regenerate.",
    "export const SEATS = {",
    ...rows,
    "} as const;",
    "",
  ].join("\n");
}

/** One file of a skill: path relative to the skill directory, `/`-separated. */
export interface SkillFile {
  path: string;
  content: string;
  executable: boolean;
}

export type SkillSources = Record<string, SkillFile[]>;

async function readSkillFiles(skillDirectory: string): Promise<SkillFile[]> {
  const entries = await readdir(skillDirectory, { recursive: true, withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
      .map(async (entry) => {
        const absolute = path.join(entry.parentPath, entry.name);
        const bytes = await readFile(absolute);
        const content = bytes.toString("utf8");
        // The module embeds text; a file that does not round-trip through UTF-8 would ship altered.
        if (!Buffer.from(content, "utf8").equals(bytes)) {
          throw new Error(`${absolute} is not UTF-8 text`);
        }
        return {
          path: path.relative(skillDirectory, absolute).split(path.sep).join("/"),
          content,
          executable: ((await stat(absolute)).mode & 0o100) !== 0,
        };
      }),
  );
  return files.sort(byPath);
}

/** Code-unit order, so the generated module does not depend on the machine's locale. */
function byPath(a: SkillFile, b: SkillFile): number {
  if (a.path === b.path) return 0;
  return a.path < b.path ? -1 : 1;
}

/** Every file of every skill directory in `skills/`, keyed by skill name. */
export async function readSkillSources(pluginDirectory: string): Promise<SkillSources> {
  const skillsDirectory = path.join(pluginDirectory, "skills");
  const names = (await readdir(skillsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
  const entries = await Promise.all(
    names.map(
      async (name) => [name, await readSkillFiles(path.join(skillsDirectory, name))] as const,
    ),
  );
  return Object.fromEntries(entries);
}

export function renderSkillsModule(sources: SkillSources): string {
  const rows: string[] = [];
  for (const [skill, files] of Object.entries(sources)) {
    rows.push(`  ${JSON.stringify(skill)}: [`);
    for (const file of files) {
      rows.push(
        `    { path: ${JSON.stringify(file.path)}, executable: ${file.executable}, content: ${JSON.stringify(file.content)} },`,
      );
    }
    rows.push("  ],");
  }
  return [
    "// Generated from skills/ by `npm run generate` (server/scripts/generate-seats.ts).",
    "// Do not edit by hand: edit skills/<name>/ and regenerate.",
    "export const SKILLS: Record<",
    "  string,",
    "  ReadonlyArray<{ path: string; executable: boolean; content: string }>",
    "> = {",
    ...rows,
    "};",
    "",
  ].join("\n");
}
