import { afterEach, describe, expect, it } from "vitest";
import type { PaseoApi, SubscriptionObserver } from "@getpaseo/client";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
// The bundled slp plugin (packages/server bootstrap) is an alp fork addition; this suite runs its
// real client entry inside the real registry, which only the app test environment can load.
import contribute from "../../../../plugins/slp/index.client";
import { createPluginHosts } from "./hosts";
import { PluginRegistry } from "./registry";

type SettingsRead =
  | { status: "ready"; revision: string; values: unknown }
  | { status: "invalid"; revision: string; error: string };

type EventObserver = SubscriptionObserver<{ subscriptionId: string }>;

/**
 * One host as the slp client entry sees it: the settings the daemon would return for
 * `settings.slp.read`, the `slp.supervisor.ensure` calls it received, and the
 * `status.plugin_settings_changed` feed a settings write would push. Only the network edge is
 * faked; the entry runs inside the app's real plugin registry, so `sidebarItems` below is what
 * the sidebar renders.
 */
function host(initial: SettingsRead | Error) {
  let settings: SettingsRead | Error = initial;
  const ensureCalls: string[] = [];
  const settingsReads: string[] = [];
  const observers = new Set<EventObserver>();
  let released = 0;
  const rpc = async (contract: { name: string }) => {
    if (contract.name === "settings.slp.read") {
      settingsReads.push(contract.name);
      if (settings instanceof Error) throw settings;
      return settings;
    }
    if (contract.name === "slp.supervisor.ensure") {
      ensureCalls.push(contract.name);
      return { workspaceId: "ws-supervisor", agentId: "agent-supervisor", created: false };
    }
    throw new Error(`Unexpected plugin RPC ${contract.name}`);
  };
  const observeEvents = ((events: string[]) => {
    expect(events).toEqual(["status.plugin_settings_changed"]);
    let observer: EventObserver | null = null;
    return {
      subscriptionId: "events-1",
      ready: Promise.resolve({ subscriptionId: "events-1" }),
      subscribe(next: EventObserver) {
        observer = next;
        observers.add(next);
        // The daemon answers the subscription request with a snapshot, after the entry returns.
        queueMicrotask(() => next.snapshot({ subscriptionId: "events-1" }));
        return () => {
          if (observer) observers.delete(observer);
        };
      },
      async release() {
        released += 1;
        if (observer) observers.delete(observer);
      },
    };
  }) as unknown as PaseoApi["observeEvents"];

  const registry = new PluginRegistry({
    version: "0.8.0",
    createRuntime: (installation) => ({
      hosts: createPluginHosts(
        {
          getHosts: () => [],
          getSnapshot: () => null,
          subscribeAll: () => () => {},
          subscribeHostList: () => () => {},
        },
        installation.lifetime.signal,
      ),
      paseo: { observeEvents, dispose: async () => {} } as unknown as PaseoApi,
      rpc: rpc as never,
      openSurface: () => {},
      openSettings: () => {},
      openPanel: () => {},
      addComposerPill: () => ({ update() {}, remove() {} }),
      addHeaderButton: () => ({ update() {}, remove() {} }),
    }),
  });
  let published = 0;
  registry.subscribe(() => {
    published += 1;
  });

  Reflect.set(globalThis, "__slpClientEntry", contribute);
  registry.installCatalog(
    "host",
    [
      {
        id: "slp",
        requirements: { paseo: ">=0.8.0" },
        clientBundle: "(function() { return { default: globalThis.__slpClientEntry }; })",
      },
    ] as never,
    { client: {} as DaemonClient },
  );

  return {
    registry,
    ensureCalls,
    settingsReads,
    get released() {
      return released;
    },
    get published() {
      return published;
    },
    sidebarItemIds: () =>
      (registry.getSnapshot().find((plugin) => plugin.id === "slp")?.sidebarItems ?? []).map(
        (item) => item.id,
      ),
    surfaceIds: () =>
      (registry.getSnapshot().find((plugin) => plugin.id === "slp")?.surfaces ?? []).map(
        (surface) => surface.id,
      ),
    /** What the daemon does after `settings.slp.write` saves new values on this host. */
    writeSettings(next: SettingsRead | Error, settingsId = "slp") {
      settings = next;
      for (const observer of observers) {
        observer.update({
          type: "status",
          payload: { status: "plugin_settings_changed", pluginId: "slp", settingsId },
        } as never);
      }
    },
  };
}

const ready = (enabled: boolean, revision = "r1"): SettingsRead => ({
  status: "ready",
  revision,
  values: { enabled, supervisorModel: null },
});

/** Lets pending RPC promises settle so a negative assertion is not a race. */
async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

let active: ReturnType<typeof host> | null = null;
function start(initial: SettingsRead | Error) {
  active = host(initial);
  return active;
}
afterEach(() => {
  active?.registry.removeHost("host");
  active = null;
  Reflect.deleteProperty(globalThis, "__slpClientEntry");
});

describe("slp client entry on load", () => {
  it("adds the Supervisor sidebar item and ensures the Supervisor when SLP is enabled", async () => {
    const h = start(ready(true));

    await expect.poll(() => h.sidebarItemIds()).toEqual(["supervisor"]);
    await expect.poll(() => h.ensureCalls).toEqual(["slp.supervisor.ensure"]);
    expect(h.surfaceIds()).toEqual(["supervisor"]);
  });

  it("adds no sidebar item and ensures nothing when SLP is disabled on the host", async () => {
    const h = start(ready(false));

    await settle();
    expect(h.sidebarItemIds()).toEqual([]);
    expect(h.ensureCalls).toEqual([]);
  });

  it("treats an invalid stored state as the default, enabled", async () => {
    const h = start({ status: "invalid", revision: "r1", error: "corrupt file" });

    await expect.poll(() => h.sidebarItemIds()).toEqual(["supervisor"]);
    await expect.poll(() => h.ensureCalls).toEqual(["slp.supervisor.ensure"]);
  });

  it("treats a failed settings read as the default, enabled", async () => {
    const h = start(new Error("settings rpc unavailable"));

    await expect.poll(() => h.sidebarItemIds()).toEqual(["supervisor"]);
    await expect.poll(() => h.ensureCalls).toEqual(["slp.supervisor.ensure"]);
  });
});

describe("slp client entry when the host setting changes", () => {
  it("removes the sidebar item after SLP is switched off, without reloading the plugin", async () => {
    const h = start(ready(true));
    await expect.poll(() => h.sidebarItemIds()).toEqual(["supervisor"]);
    const installation = h.registry.getSnapshot()[0];
    const publishedBefore = h.published;

    h.writeSettings(ready(false, "r2"));

    await expect.poll(() => h.sidebarItemIds()).toEqual([]);
    expect(h.published).toBeGreaterThan(publishedBefore);
    expect(h.registry.getSnapshot()[0]).toBe(installation);
    expect(h.surfaceIds()).toEqual(["supervisor"]);
    expect(h.ensureCalls).toEqual(["slp.supervisor.ensure"]);
  });

  it("adds the sidebar item back and ensures the Supervisor after SLP is switched on", async () => {
    const h = start(ready(false));
    await settle();
    expect(h.sidebarItemIds()).toEqual([]);

    h.writeSettings(ready(true, "r2"));

    await expect.poll(() => h.sidebarItemIds()).toEqual(["supervisor"]);
    await expect.poll(() => h.ensureCalls).toEqual(["slp.supervisor.ensure"]);
  });

  it("ignores changes to another settings definition", async () => {
    const h = start(ready(true));
    await expect.poll(() => h.sidebarItemIds()).toEqual(["supervisor"]);
    await settle();
    const reads = h.settingsReads.length;

    h.writeSettings(ready(false, "r2"), "other");
    await settle();

    expect(h.settingsReads.length).toBe(reads);
    expect(h.sidebarItemIds()).toEqual(["supervisor"]);
  });

  it("releases its settings observation when the plugin unloads", async () => {
    const h = start(ready(true));
    await expect.poll(() => h.sidebarItemIds()).toEqual(["supervisor"]);

    h.registry.removeHost("host");

    await expect.poll(() => h.released).toBe(1);
  });
});
