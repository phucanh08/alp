import { useCallback, useMemo, useSyncExternalStore } from "react";
import { QueryObserver, useMutation, type QueryObserverResult } from "@tanstack/react-query";
import { callPluginRpc } from "@getpaseo/plugin/client/host";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useInstalledPlugin } from "../registry";
import { pluginSettingsKey } from "../settings/use-settings";
import type { InstalledPlugin } from "../types";
import {
  isSlpEnabled,
  slpSettings,
  slpSettingsRpc,
  type SlpSettingsRead,
  type SlpSettingsValues,
} from "./slp-settings-contract";

const SLP_PLUGIN_ID = "slp";

export type SlpSettingsPatch = Partial<SlpSettingsValues>;

/**
 * The host's `slp` settings as app UI reads them.
 *
 * - `unavailable`: the host runs no `slp` plugin (an upstream or older daemon, or it is offline).
 * - `error`: the read failed. SLP counts as enabled, the same ruling as the plugin's client gate.
 * - `ready`: `enabled` and `supervisorModel` are the effective values. An invalid stored state, or
 *   stored values the schema rejects, count as the defaults (enabled, no Supervisor model), the
 *   same ruling as `plugins/slp/server/settings.ts`. `save` writes the stored values merged with
 *   the patch and resolves `false` when the host rejects the write; `saveError` then says why.
 */
export type SlpSettings =
  | { status: "unavailable" }
  | { status: "loading" }
  | { status: "error"; error: string; enabled: true }
  | {
      status: "ready";
      enabled: boolean;
      supervisorModel: string | null;
      saving: boolean;
      saveError: string | null;
      save(patch: SlpSettingsPatch): Promise<boolean>;
    };

interface SlpSettingsWrite {
  plugin: InstalledPlugin;
  client: DaemonClient;
  revision: string;
  values: SlpSettingsValues;
}

const settingsKey = pluginSettingsKey(slpSettings.id);

function invokeSlp(client: DaemonClient, plugin: InstalledPlugin) {
  return (method: string, input: unknown) => client.invokePluginRpc(plugin.id, method, input);
}

function storedValues(read: SlpSettingsRead): SlpSettingsValues {
  const parsed = read.status === "ready" ? slpSettings.schema.safeParse(read.values) : null;
  return parsed?.success ? parsed.data : slpSettings.schema.parse({});
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads through the plugin installation's own query cache, the one `PluginCatalogSync`
 * invalidates on `status.plugin_settings_changed`, so a save from any client shows up here.
 * A `QueryObserver` rather than `useQuery`: that cache arrives and is replaced with the plugin
 * installation, and `useQuery` keeps the client it first rendered with.
 */
function useSlpSettingsRead(
  plugin: InstalledPlugin | null,
  client: DaemonClient | null,
): QueryObserverResult<SlpSettingsRead> | null {
  const observer = useMemo(() => {
    if (!plugin || !client) return null;
    return new QueryObserver<SlpSettingsRead>(plugin.queryClient, {
      queryKey: settingsKey,
      queryFn: () => callPluginRpc(slpSettingsRpc.read, invokeSlp(client, plugin), {}),
      retry: false,
      gcTime: Infinity,
      staleTime: Infinity,
      refetchOnMount: false,
      refetchOnReconnect: false,
      refetchOnWindowFocus: false,
    });
  }, [plugin, client]);
  const subscribe = useCallback(
    (listener: () => void) => (observer ? observer.subscribe(listener) : () => undefined),
    [observer],
  );
  const getSnapshot = useCallback(() => observer?.getCurrentResult() ?? null, [observer]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useSlpSettings(serverId: string): SlpSettings {
  const plugin = useInstalledPlugin(serverId, SLP_PLUGIN_ID);
  const client = useHostRuntimeClient(serverId);
  const read = useSlpSettingsRead(plugin, client);
  const mutation = useMutation({
    mutationFn: async (write: SlpSettingsWrite) => {
      const result = await callPluginRpc(
        slpSettingsRpc.write,
        invokeSlp(write.client, write.plugin),
        { revision: write.revision, values: write.values },
      );
      if (result.status !== "saved") throw new Error(result.error);
      write.plugin.queryClient.setQueryData<SlpSettingsRead>(settingsKey, {
        status: "ready",
        revision: result.revision,
        values: result.values,
      });
    },
  });
  const { mutateAsync, isPending: saving, error: mutationError } = mutation;
  const data = read?.data;

  const save = useCallback(
    async (patch: SlpSettingsPatch) => {
      if (!plugin || !client || !data) return false;
      try {
        await mutateAsync({
          plugin,
          client,
          revision: data.revision,
          values: { ...storedValues(data), ...patch },
        });
        return true;
      } catch {
        return false;
      }
    },
    [client, data, mutateAsync, plugin],
  );
  const saveError = mutationError ? errorMessage(mutationError) : null;

  return useMemo<SlpSettings>(() => {
    if (!read) return { status: "unavailable" };
    if (read.status === "error") {
      return { status: "error", error: errorMessage(read.error), enabled: true };
    }
    if (!data) return { status: "loading" };
    return {
      status: "ready",
      enabled: isSlpEnabled(data),
      supervisorModel: storedValues(data).supervisorModel,
      saving,
      saveError,
      save,
    };
  }, [data, read, save, saveError, saving]);
}
