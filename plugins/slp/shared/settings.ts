import { defineSettings } from "@alp/plugin";
import { z } from "zod";

/**
 * Host-scoped SLP switch. `enabled` (default `true`) gates every SLP behavior in
 * `index.server.ts`: seat injection on `agent.create`, automatic Lead creation on
 * `workspace.created`, and the `slp.lead.ensure` / `slp.supervisor.ensure` RPCs. `supervisorModel`
 * (default `null`) picks the model a freshly created Supervisor runs on, when it names a selectable
 * model of the Supervisor's provider; `null`, or a value that names no such model, falls back to the
 * provider's default model. A live or resumed Supervisor keeps its own model regardless of this
 * setting. See `server/ensure.ts` (`ensureSupervisor`) and `server/settings.ts` (`supervisorModel`).
 * `supervisorCheckMinutes` (default `10`, `0` = off) is how many working minutes a Lead may go
 * without messaging a Supervisor before slp asks the Supervisor to check it; see
 * `server/supervisor-check.ts`. Settings saved before the field existed read it as the default, so
 * adding it needed no version bump.
 */
export const slpSettings = defineSettings({
  id: "slp",
  scope: "host",
  version: 1,
  schema: z.object({
    enabled: z.boolean().default(true),
    supervisorModel: z.string().nullable().default(null),
    supervisorCheckMinutes: z.number().int().min(0).default(10),
  }),
});

export type SlpSettingsValues = z.infer<typeof slpSettings.schema>;
