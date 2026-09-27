import type { PluginServerContext } from "@alp/plugin/server";
import { SEATS } from "./server/seats.gen";
import { SKILLS } from "./server/skills.gen";
import { slpDevSeatGet, slpDevSkillsGet } from "./shared/rpc";

/**
 * slp-dev: the SLP developer workflow. It ships the seat rules and the skills each seat uses.
 * `slp-dev.seat.get` answers a seat's rule text and skill list; `slp-dev.skills.get` answers the
 * files of that seat's skills, which `plugins/slp` writes into the seat's skill directory. The
 * daemon does not install `skills/` anywhere (manifest `install: false`).
 */
export default function contribute(server: PluginServerContext) {
  server.handle(slpDevSeatGet, async ({ seat }) => {
    const { definition, skills } = SEATS[seat];
    return { definition, skills: [...skills] };
  });
  server.handle(slpDevSkillsGet, async ({ seat }) => ({
    files: SEATS[seat].skills.flatMap((skill) =>
      (SKILLS[skill] ?? []).map(({ path, content, executable }) => ({
        path: `${skill}/${path}`,
        content,
        executable,
      })),
    ),
  }));
  return () => {};
}
