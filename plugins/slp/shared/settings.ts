import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Host-scoped SLP switch. `enabled` (default `true`) gates every SLP behavior in
 * `index.server.ts`: seat injection on `agent.create`, automatic Lead creation on
 * `workspace.created`, and the `slp.lead.ensure` / `slp.supervisor.ensure` RPCs. `supervisorModel`
 * (default `null`) picks the model a freshly created Supervisor runs on, when it names a selectable
 * model of the Supervisor's provider; `null`, or a value that names no such model, falls back to the
 * provider's default model. A live or resumed Supervisor keeps its own model regardless of this
 * setting. See `server/ensure.ts` (`ensureSupervisor`) and `server/settings.ts` (`supervisorModel`).
 */
export const slpSettings = defineSettings({
  id: "slp",
  scope: "host",
  version: 1,
  schema: z.object({
    enabled: z.boolean().default(true),
    supervisorModel: z.string().nullable().default(null),
  }),
});

export type SlpSettingsValues = z.infer<typeof slpSettings.schema>;
