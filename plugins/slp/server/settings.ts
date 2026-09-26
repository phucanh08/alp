import type { PluginSettingsState } from "@getpaseo/plugin/server";
import type { slpSettings } from "../shared/settings";

export type SlpSettingsState = PluginSettingsState<typeof slpSettings.schema>;

/**
 * `enabled` as every hook and RPC reads it: an `invalid` stored state (corrupt file, a migration
 * that failed) counts as the schema default, enabled — ruling p11, not a fallback to guess at.
 */
export function isEnabled(state: SlpSettingsState): boolean {
  return state.status !== "ready" || state.values.enabled;
}

/**
 * `supervisorModel` as `slp.supervisor.ensure` reads it: an `invalid` stored state counts as the
 * schema default, `null` — same ruling as `isEnabled`.
 */
export function supervisorModel(state: SlpSettingsState): string | null {
  return state.status === "ready" ? state.values.supervisorModel : null;
}
