import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** A seat's rule text (`agents/<seat>.md`, verbatim) and the skills that seat uses (`seats.json`). */
export const slpDevSeatGet = defineRpc({
  name: "slp-dev.seat.get",
  input: z.object({ seat: z.enum(["lead", "peer", "supervisor"]) }),
  output: z.object({ definition: z.string(), skills: z.array(z.string()) }),
});
