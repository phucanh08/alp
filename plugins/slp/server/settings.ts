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

/**
 * Minutes a working Lead may stay silent towards the Supervisor before slp nudges it; `0` is off.
 * SLP off (`enabled: false`) reads as `0`. An `invalid` stored state counts as the schema default,
 * `10` — same ruling as `isEnabled`.
 */
export function supervisorCheckMinutes(state: SlpSettingsState): number {
  if (state.status !== "ready") return 10;
  return state.values.enabled ? state.values.supervisorCheckMinutes : 0;
}
