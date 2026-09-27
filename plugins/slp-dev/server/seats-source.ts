import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Seat content shipped with the plugin: `agents/<seat>.md` is a seat's rule text and `seats.json`
 * maps each seat to its skills. `seats.gen.ts` embeds both because the plugin compiler bundles
 * `server/` into one string that the daemon evaluates: at runtime the plugin has no path to its own
 * directory, and esbuild has no loader for `.md`.
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
