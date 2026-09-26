/**
 * @vitest-environment jsdom
 */
import React, { type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createFakeSlpHost, type FakeSettingsRead, type FakeSlpHost } from "./fakes";

const { hostClients } = vi.hoisted(() => ({ hostClients: new Map<string, DaemonClient>() }));

// The plugin's client bundle and its runtime are not what this suite checks; the registry,
// catalog sync, and settings cache around them are real.
vi.mock("../evaluate", () => ({
  runPluginClientBundle: (id: string) => ({
    id,
    cleanup: () => undefined,
    surfaces: [],
    settingsScreens: [],
    sidebarItems: [],
    workspacePanels: [],
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
  }),
}));
vi.mock("../client-runtime", () => ({
  createPluginClientRuntime: () => ({ paseo: { dispose: async () => undefined } }),
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: (serverId: string) => hostClients.get(serverId) ?? null,
  useHostRuntimeIsConnected: (serverId: string) => hostClients.has(serverId),
}));
vi.mock("@/runtime/host-features", () => ({ useHostFeature: () => true }));

import { PluginCatalogSync } from "../catalog-sync";
import { useSlpSettings } from "./use-slp-settings";

let serverCounter = 0;

function renderSlpSettings(host: FakeSlpHost) {
  serverCounter += 1;
  const serverId = `host-${serverCounter}`;
  hostClients.set(serverId, host.client);
  const queryClient = new QueryClient();
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <PluginCatalogSync serverId={serverId} client={host.client} />
        {children}
      </QueryClientProvider>
    );
  }
  return renderHook(() => useSlpSettings(serverId), { wrapper: Wrapper });
}

function ready(values: unknown, revision = "r1"): FakeSettingsRead {
  return { status: "ready", revision, values };
}

async function settle() {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

afterEach(() => {
  cleanup();
  hostClients.clear();
});

describe("useSlpSettings on read", () => {
  it("reports unavailable when the host has no slp plugin", async () => {
    const host = createFakeSlpHost({
      hasSlpPlugin: false,
      settings: ready({ enabled: true, supervisorModel: null }),
    });
    const { result } = renderSlpSettings(host);

    await expect.poll(() => host.catalogReads).toBe(1);
    await settle();
    expect(result.current).toEqual({ status: "unavailable" });
  });

  it("reports loading, then the stored enabled flag and Supervisor model", async () => {
    const host = createFakeSlpHost({
      hasSlpPlugin: true,
      settings: ready({ enabled: false, supervisorModel: "claude-opus-4-1" }),
    });
    const releaseRead = host.holdReads();
    const { result } = renderSlpSettings(host);

    await expect.poll(() => result.current.status).toBe("loading");
    releaseRead();
    await expect.poll(() => result.current.status).toBe("ready");
    expect(result.current).toMatchObject({
      status: "ready",
      enabled: false,
      supervisorModel: "claude-opus-4-1",
      saving: false,
      saveError: null,
    });
  });

  it("treats an invalid stored state as the defaults, enabled with no Supervisor model", async () => {
    const host = createFakeSlpHost({
      hasSlpPlugin: true,
      settings: { status: "invalid", revision: "r1", error: "corrupt settings file" },
    });
    const { result } = renderSlpSettings(host);

    await expect.poll(() => result.current.status).toBe("ready");
    expect(result.current).toMatchObject({ enabled: true, supervisorModel: null });
  });

  it("treats stored values that fail the schema as the defaults", async () => {
    const host = createFakeSlpHost({
      hasSlpPlugin: true,
      settings: ready({ enabled: "no", supervisorModel: 42 }),
    });
    const { result } = renderSlpSettings(host);

    await expect.poll(() => result.current.status).toBe("ready");
    expect(result.current).toMatchObject({ enabled: true, supervisorModel: null });
  });

  it("reports a failed read as an error that still counts as enabled", async () => {
    const host = createFakeSlpHost({
      hasSlpPlugin: true,
      settings: new Error("settings rpc unavailable"),
    });
    const { result } = renderSlpSettings(host);

    await expect.poll(() => result.current.status).toBe("error");
    expect(result.current).toEqual({
      status: "error",
      error: "settings rpc unavailable",
      enabled: true,
    });
  });

  it("shows a value saved elsewhere without remounting", async () => {
    const host = createFakeSlpHost({
      hasSlpPlugin: true,
      settings: ready({ enabled: true, supervisorModel: null }),
    });
    const { result } = renderSlpSettings(host);
    await expect.poll(() => result.current.status).toBe("ready");

    host.changeSettingsElsewhere(
      ready({ enabled: false, supervisorModel: "claude-sonnet-4-5" }, "r7"),
    );

    await expect
      .poll(() => result.current)
      .toMatchObject({
        enabled: false,
        supervisorModel: "claude-sonnet-4-5",
      });
  });
});

describe("useSlpSettings on save", () => {
  it("writes the full values with the read revision and shows the saved value", async () => {
    const host = createFakeSlpHost({
      hasSlpPlugin: true,
      settings: ready({ enabled: true, supervisorModel: "claude-opus-4-1" }, "r1"),
    });
    const { result } = renderSlpSettings(host);
    await expect.poll(() => result.current.status).toBe("ready");
    const current = result.current;
    if (current.status !== "ready") throw new Error("expected ready");

    let saved: boolean | undefined;
    await act(async () => {
      saved = await current.save({ enabled: false });
    });

    expect(saved).toBe(true);
    expect(host.writes).toEqual([
      { revision: "r1", values: { enabled: false, supervisorModel: "claude-opus-4-1" } },
    ]);
    expect(result.current).toMatchObject({ enabled: false, supervisorModel: "claude-opus-4-1" });
  });

  it("writes a null Supervisor model for the default choice", async () => {
    const host = createFakeSlpHost({
      hasSlpPlugin: true,
      settings: ready({ enabled: true, supervisorModel: "claude-opus-4-1" }, "r3"),
    });
    const { result } = renderSlpSettings(host);
    await expect.poll(() => result.current.status).toBe("ready");
    const current = result.current;
    if (current.status !== "ready") throw new Error("expected ready");

    await act(async () => {
      await current.save({ supervisorModel: null });
    });

    expect(host.writes).toEqual([
      { revision: "r3", values: { enabled: true, supervisorModel: null } },
    ]);
    expect(result.current).toMatchObject({ enabled: true, supervisorModel: null });
  });

  it("writes over an invalid stored state starting from the defaults", async () => {
    const host = createFakeSlpHost({
      hasSlpPlugin: true,
      settings: { status: "invalid", revision: "r5", error: "corrupt settings file" },
    });
    const { result } = renderSlpSettings(host);
    await expect.poll(() => result.current.status).toBe("ready");
    const current = result.current;
    if (current.status !== "ready") throw new Error("expected ready");

    await act(async () => {
      await current.save({ supervisorModel: "claude-sonnet-4-5" });
    });

    expect(host.writes).toEqual([
      { revision: "r5", values: { enabled: true, supervisorModel: "claude-sonnet-4-5" } },
    ]);
  });

  it("reports a rejected write as a save error and keeps the stored value", async () => {
    const host = createFakeSlpHost({
      hasSlpPlugin: true,
      settings: ready({ enabled: true, supervisorModel: null }, "r1"),
    });
    host.rejectNextWrite({ status: "conflict", error: "Settings changed on the host" });
    const { result } = renderSlpSettings(host);
    await expect.poll(() => result.current.status).toBe("ready");
    const current = result.current;
    if (current.status !== "ready") throw new Error("expected ready");

    let saved: boolean | undefined;
    await act(async () => {
      saved = await current.save({ enabled: false });
    });

    expect(saved).toBe(false);
    await expect
      .poll(() => result.current)
      .toMatchObject({
        enabled: true,
        saving: false,
        saveError: "Settings changed on the host",
      });
  });
});
