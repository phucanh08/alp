import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Seat files shipped with the plugin. `agents/<seat>.md` is the source; `definitions.gen.ts`
 * embeds it because the plugin compiler bundles `server/` into one string that the daemon evaluates:
 * at runtime the plugin has no path to its own directory, and esbuild has no loader for `.md`.
 */
export const DEFINITION_SEATS = ["lead", "peer", "supervisor"] as const;

export type DefinitionSources = Record<(typeof DEFINITION_SEATS)[number], string>;

export async function readDefinitionSources(agentsDirectory: string): Promise<DefinitionSources> {
  const entries = await Promise.all(
    DEFINITION_SEATS.map(
      async (seat) =>
        [seat, await readFile(path.join(agentsDirectory, `${seat}.md`), "utf8")] as const,
    ),
  );
  return Object.fromEntries(entries) as DefinitionSources;
}

export function renderDefinitionsModule(sources: DefinitionSources): string {
  const rows = DEFINITION_SEATS.map((seat) => `  ${seat}: ${JSON.stringify(sources[seat])},`);
  return [
    "// Generated from agents/*.md by `npm run generate` (server/scripts/generate-definitions.ts).",
    "// Do not edit by hand: edit agents/<seat>.md and regenerate.",
    "export const BUNDLED_DEFINITIONS = {",
    ...rows,
    "} as const;",
    "",
  ].join("\n");
}
