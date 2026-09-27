import { settingsRpc, type RpcOutput } from "@alp/plugin";
import type { PluginClientContext } from "@alp/plugin/client";
import { slpSettings } from "../shared/settings";

// Bundled plugin code types the host API through the plugin SDK only: the packaged app ships no
// `@alp/client` declarations, and the plugin compiler cannot resolve a type import it can't find.
type AlpApi = PluginClientContext["alp"];

export const slpSettingsRpc = settingsRpc(slpSettings.id);

type SlpSettingsRead = RpcOutput<typeof slpSettingsRpc.read>;

/**
 * `enabled` as the client reads it. Only a `ready` state whose values parse to `enabled: false`
 * turns SLP off; an `invalid` state or values that fail the schema count as the default, enabled.
 * Same ruling p11 as `server/settings.ts` (`isEnabled`).
 */
export function isSlpEnabled(result: SlpSettingsRead): boolean {
  if (result.status !== "ready") return true;
  const parsed = slpSettings.schema.safeParse(result.values);
  return !parsed.success || parsed.data.enabled;
}

/**
 * Calls `refresh` when the host's slp settings may have changed: once the daemon acknowledges the
 * event subscription (first load and every reconnect), and after each save, reset, or migration
 * of the `slp` definition. The app evaluates the client entry once per host connection and does
 * not re-run it on settings changes, so the entry watches the daemon's
 * `status.plugin_settings_changed` feed itself. A feed that cannot start still gets one refresh,
 * so the entry falls back to a load-time read.
 */
export function watchSlpSettings(
  alp: Pick<AlpApi, "observeEvents">,
  refresh: () => void,
): () => void {
  let observation: ReturnType<AlpApi["observeEvents"]>;
  try {
    observation = alp.observeEvents(["status.plugin_settings_changed"]);
  } catch {
    refresh();
    return () => undefined;
  }
  const unsubscribe = observation.subscribe({
    snapshot: refresh,
    update: (message) => {
      if (message.type !== "status") return;
      if (message.payload.status !== "plugin_settings_changed") return;
      if (message.payload.settingsId === slpSettings.id) refresh();
    },
    error: refresh,
  });
  return () => {
    unsubscribe();
    void observation.release().catch(() => undefined);
  };
}

/**
 * Keeps the Supervisor sidebar item in step with the host's `enabled` setting. `show` registers the
 * item and returns its removal; `ensure` runs each time the item appears, so switching SLP back on
 * creates the Supervisor without a reload. When reads overlap, the most recent one wins. A failed
 * read counts as enabled. Returns the synchronous cleanup the client entry hands back to the app.
 */
export function gateSupervisor(input: {
  readEnabled: () => Promise<boolean>;
  watch: (refresh: () => void) => () => void;
  show: () => () => void;
  ensure: () => void;
}): () => void {
  let stopped = false;
  let latest = 0;
  let hide: (() => void) | null = null;

  const apply = (enabled: boolean) => {
    if (enabled && !hide) {
      hide = input.show();
      input.ensure();
    } else if (!enabled && hide) {
      const remove = hide;
      hide = null;
      remove();
    }
  };

  const refresh = () => {
    if (stopped) return;
    latest += 1;
    const request = latest;
    void input
      .readEnabled()
      .catch(() => true)
      .then((enabled) => {
        if (stopped || request !== latest) return;
        apply(enabled);
        return undefined;
      });
  };

  const stopWatching = input.watch(refresh);
  return () => {
    stopped = true;
    stopWatching();
    hide?.();
    hide = null;
  };
}
