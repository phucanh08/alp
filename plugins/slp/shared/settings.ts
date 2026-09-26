import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Host-scoped SLP switch. `enabled` (default `true`) gates every SLP behavior in
 * `index.server.ts`: seat injection on `agent.create`, automatic Lead creation on
 * `workspace.created`, and the `slp.lead.ensure` / `slp.supervisor.ensure` RPCs. `supervisorModel`
 * is declared for F2, which picks the Supervisor's model from it; F1 only declares the field and
 * never reads it.
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
