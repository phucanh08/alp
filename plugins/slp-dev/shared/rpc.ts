import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** A seat's rule text (`agents/<seat>.md`, verbatim) and the skills that seat uses (`seats.json`). */
export const slpDevSeatGet = defineRpc({
  name: "slp-dev.seat.get",
  input: z.object({ seat: z.enum(["lead", "peer", "supervisor"]) }),
  output: z.object({ definition: z.string(), skills: z.array(z.string()) }),
});

/**
 * Every file of a seat's skills (`skills/<name>/**` for each name `seats.json` lists), verbatim.
 * `path` is relative to `skills/` (`<skill>/<file>`, `/`-separated); `executable` is the owner
 * execute bit. `plugins/slp` writes these into the seat's skill directory.
 */
export const slpDevSkillsGet = defineRpc({
  name: "slp-dev.skills.get",
  input: z.object({ seat: z.enum(["lead", "peer", "supervisor"]) }),
  output: z.object({
    files: z.array(z.object({ path: z.string(), content: z.string(), executable: z.boolean() })),
  }),
});
