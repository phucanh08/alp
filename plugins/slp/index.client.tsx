import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ensureSupervisorOnLoad } from "./client/ensure-supervisor";
import { SupervisorSurface } from "./client/supervisor-surface";
import { ensureSupervisorRpc } from "./client/supervisor-rpc";

export default function contribute(client: PluginClientContext) {
  let stopped = false;

  client.addSurface("supervisor", SupervisorSurface);
  client.addSidebarItem({
    id: "supervisor",
    title: "Supervisor",
    icon: "ShieldCheck",
    surface: "supervisor",
  });

  // The app evaluates this entry once per host connection, so the Supervisor exists on first
  // launch without a click. Unload rejects the pending call; that rejection is not worth a log.
  void ensureSupervisorOnLoad({
    ensure: () => client.rpc(ensureSupervisorRpc, {}),
    warn: (message, error) => {
      if (!stopped) console.warn(message, error);
    },
  });

  return () => {
    stopped = true;
  };
}
