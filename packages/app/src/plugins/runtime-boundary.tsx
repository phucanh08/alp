import { QueryClientProvider } from "@tanstack/react-query";
import { AlpApiProvider, PluginRpcProvider } from "@alp/plugin/client/host";
import type { ReactNode } from "react";
import type { InstalledPlugin } from "./types";
import { usePluginSurfaceRuntime } from "./surface-runtime";
import type { DaemonClient } from "@alp/client/internal/daemon-client";

export function PluginRuntimeBoundary({
  plugin,
  client,
  children,
}: {
  plugin: InstalledPlugin;
  client: DaemonClient;
  children: ReactNode;
}) {
  const runtime = usePluginSurfaceRuntime(client, plugin);
  if (!runtime) return null;
  return (
    <QueryClientProvider client={plugin.queryClient}>
      <AlpApiProvider alp={runtime.alp}>
        <PluginRpcProvider invoke={runtime.invoke}>{children}</PluginRpcProvider>
      </AlpApiProvider>
    </QueryClientProvider>
  );
}
