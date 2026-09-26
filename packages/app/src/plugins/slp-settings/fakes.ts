import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";

export type FakeSettingsRead =
  | { status: "ready"; revision: string; values: unknown }
  | { status: "invalid"; revision: string; error: string };

type FakeWriteResult =
  | { status: "saved" }
  | { status: "conflict"; error: string }
  | { status: "invalid"; error: string };

interface FakeEventObserver {
  snapshot?: (payload: { subscriptionId: string }) => void;
  update?: (message: unknown) => void;
  error?: (error: unknown) => void;
}

export interface FakeSlpWrite {
  revision: string;
  values: unknown;
}

/**
 * One host as the app sees it over the network: its plugin catalog (with or without the bundled
 * `slp` plugin), the `settings.slp.*` RPCs, and the `status.plugin_settings_changed` feed the
 * daemon pushes after every save. Everything above the daemon client is real app code.
 */
export function createFakeSlpHost(input: {
  hasSlpPlugin: boolean;
  settings: FakeSettingsRead | Error;
}) {
  let settings = input.settings;
  let nextWrite: FakeWriteResult = { status: "saved" };
  let revision = 1;
  let catalogReads = 0;
  let heldRead: Promise<void> | null = null;
  const writes: FakeSlpWrite[] = [];
  const observers = new Set<FakeEventObserver>();

  function pushSettingsChanged() {
    for (const observer of observers) {
      observer.update?.({
        type: "status",
        payload: { status: "plugin_settings_changed", pluginId: "slp", settingsId: "slp" },
      });
    }
  }

  function write(request: FakeSlpWrite) {
    writes.push(request);
    if (nextWrite.status !== "saved") return nextWrite;
    revision += 1;
    settings = { status: "ready", revision: `r${revision}`, values: request.values };
    queueMicrotask(pushSettingsChanged);
    return { status: "saved", revision: `r${revision}`, values: request.values };
  }

  const client = {
    async getPluginCatalog() {
      catalogReads += 1;
      return input.hasSlpPlugin
        ? [{ id: "slp", requirements: { paseo: ">=0.8.0" }, clientBundle: "slp-client-bundle" }]
        : [];
    },
    observeEvents() {
      let own: FakeEventObserver | null = null;
      return {
        subscriptionId: "events-1",
        subscribe(observer: FakeEventObserver) {
          own = observer;
          observers.add(observer);
          queueMicrotask(() => observer.snapshot?.({ subscriptionId: "events-1" }));
          return () => {
            if (own) observers.delete(own);
          };
        },
        async release() {
          if (own) observers.delete(own);
        },
      };
    },
    async invokePluginRpc(pluginId: string, method: string, request: unknown) {
      if (pluginId !== "slp") throw new Error(`Unexpected plugin ${pluginId}`);
      if (method === "settings.slp.read") {
        if (heldRead) await heldRead;
        if (settings instanceof Error) throw settings;
        return settings;
      }
      if (method === "settings.slp.write") return write(request as FakeSlpWrite);
      throw new Error(`Unexpected plugin RPC ${method}`);
    },
  };

  return {
    client: client as unknown as DaemonClient,
    writes,
    get catalogReads() {
      return catalogReads;
    },
    /** Another client or a file edit saved new settings; the daemon pushes the change event. */
    changeSettingsElsewhere(next: FakeSettingsRead) {
      settings = next;
      pushSettingsChanged();
    },
    /** Settings reads wait until the returned function runs. */
    holdReads() {
      let release = () => undefined as void;
      heldRead = new Promise<void>((resolve) => {
        release = () => {
          heldRead = null;
          resolve();
        };
      });
      return release;
    },
    /** The next `settings.slp.write` answers with this result instead of saving. */
    rejectNextWrite(result: Exclude<FakeWriteResult, { status: "saved" }>) {
      nextWrite = result;
    },
  };
}

export type FakeSlpHost = ReturnType<typeof createFakeSlpHost>;
