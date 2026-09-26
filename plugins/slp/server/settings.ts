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
