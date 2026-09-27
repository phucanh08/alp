import type { PluginServerContext } from "@getpaseo/plugin/server";
import { SEATS } from "./server/seats.gen";
import { slpDevSeatGet } from "./shared/rpc";

/**
 * slp-dev: the SLP developer workflow. It ships the seat rules and the skills each seat uses; the
 * daemon installs the skills from `skills/` (manifest `skills`), and `slp-dev.seat.get` answers a
 * seat's rule text and skill list.
 */
export default function contribute(server: PluginServerContext) {
  server.handle(slpDevSeatGet, async ({ seat }) => {
    const { definition, skills } = SEATS[seat];
    return { definition, skills: [...skills] };
  });
}
