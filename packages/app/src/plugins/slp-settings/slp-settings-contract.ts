import { defineSettings, settingsRpc, type RpcOutput } from "@getpaseo/plugin";
import { z } from "zod";

// Mirror of the bundled slp plugin's settings contract: `plugins/slp/shared/settings.ts` (the
// definition) and `plugins/slp/client/supervisor-gate.ts` (`slpSettingsRpc`, `isSlpEnabled`).
// Metro does not resolve files outside the app workspace, so the app cannot import the plugin's
// source. `slp-settings-contract.test.ts` fails when this copy drifts from the plugin.

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

export const slpSettingsRpc = settingsRpc(slpSettings.id);

export type SlpSettingsRead = RpcOutput<typeof slpSettingsRpc.read>;

/**
 * Only a `ready` state whose values parse to `enabled: false` turns SLP off; an `invalid` state or
 * values that fail the schema count as the default, enabled.
 */
export function isSlpEnabled(result: SlpSettingsRead): boolean {
  if (result.status !== "ready") return true;
  const parsed = slpSettings.schema.safeParse(result.values);
  return !parsed.success || parsed.data.enabled;
}
