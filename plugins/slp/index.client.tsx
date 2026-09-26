import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ensureSupervisorOnLoad } from "./client/ensure-supervisor";
import {
  gateSupervisor,
  isSlpEnabled,
  slpSettingsRpc,
  watchSlpSettings,
} from "./client/supervisor-gate";
import { SupervisorSurface } from "./client/supervisor-surface";
import { slpSupervisorEnsure } from "./shared/rpc";

export default function contribute(client: PluginClientContext) {
  let stopped = false;

  client.addSurface("supervisor", SupervisorSurface);

  // The sidebar item and the automatic Supervisor ensure follow the host's `slp.enabled` setting,
  // live: switching SLP off removes the item, switching it on adds it back and ensures the
  // Supervisor. Unload rejects a pending ensure; that rejection is not worth a log.
  const stopGate = gateSupervisor({
    readEnabled: () => client.rpc(slpSettingsRpc.read, {}).then(isSlpEnabled),
    watch: (refresh) => watchSlpSettings(client.paseo, refresh),
    show: () =>
      client.addSidebarItem({
        id: "supervisor",
        title: "Supervisor",
        icon: "ShieldCheck",
        surface: "supervisor",
      }),
    ensure: () => {
      void ensureSupervisorOnLoad({
        ensure: () => client.rpc(slpSupervisorEnsure, {}),
        warn: (message, error) => {
          if (!stopped) console.warn(message, error);
        },
      });
    },
  });

  return () => {
    stopped = true;
    stopGate();
  };
}
