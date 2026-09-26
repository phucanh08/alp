/**
 * @vitest-environment jsdom
 */
import React, { type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  createFakeSlpHost,
  type FakeSettingsRead,
  type FakeSlpHost,
} from "@/plugins/slp-settings/fakes";

const { hostClients, providerEntries } = vi.hoisted(() => ({
  hostClients: new Map<string, DaemonClient>(),
  providerEntries: [
    {
      provider: "claude",
      status: "ready",
      models: [
        { provider: "claude", id: "claude-opus-4-1", label: "Opus 4.1" },
        { provider: "claude", id: "claude-sonnet-4-5", label: "Sonnet 4.5", isSelectable: true },
        { provider: "claude", id: "claude-retired", label: "Retired", isSelectable: false },
      ],
    },
    {
      provider: "codex",
      status: "ready",
      models: [{ provider: "codex", id: "gpt-5", label: "GPT-5" }],
    },
  ],
}));

vi.mock("@/plugins/evaluate", () => ({
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
vi.mock("@/plugins/client-runtime", () => ({
  createPluginClientRuntime: () => ({ paseo: { dispose: async () => undefined } }),
}));
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: (serverId: string) => hostClients.get(serverId) ?? null,
  useHostRuntimeIsConnected: (serverId: string) => hostClients.has(serverId),
}));
vi.mock("@/runtime/host-features", () => ({ useHostFeature: () => true }));
vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({ entries: providerEntries }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

interface RowProps {
  label: string;
  hint?: string;
  error?: string | null;
  children?: ReactNode;
}

function rowText({ hint, error }: Pick<RowProps, "hint" | "error">) {
  return [
    hint ? React.createElement("span", { key: "hint" }, hint) : null,
    error ? React.createElement("span", { key: "error", role: "alert" }, error) : null,
  ];
}

// The settings kit renders React Native controls; these stand-ins keep its props observable.
vi.mock("@/components/settings", () => ({
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) =>
    React.createElement("section", { "aria-label": title }, children),
  SettingsCard: ({ children }: { children: ReactNode }) =>
    React.createElement("div", null, children),
  SettingsRow: ({ label, hint, error }: RowProps) =>
    React.createElement(
      "div",
      null,
      React.createElement("span", null, label),
      rowText({ hint, error }),
    ),
  SettingsSwitch: ({
    label,
    hint,
    error,
    value,
    disabled,
    onValueChange,
  }: RowProps & { value: boolean; disabled?: boolean; onValueChange(value: boolean): void }) =>
    React.createElement(
      "div",
      null,
      React.createElement("input", {
        type: "checkbox",
        "aria-label": label,
        checked: value,
        disabled,
        onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
          onValueChange(event.target.checked),
      }),
      rowText({ hint, error }),
    ),
  SettingsSelect: ({
    label,
    hint,
    error,
    value,
    options,
    disabled,
    onValueChange,
  }: RowProps & {
    value: string;
    options: readonly { label: string; value: string }[];
    disabled?: boolean;
    onValueChange(value: string): void;
  }) =>
    React.createElement(
      "div",
      null,
      React.createElement(
        "select",
        {
          "aria-label": label,
          value,
          disabled,
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
            onValueChange(event.target.value),
        },
        options.map((option) =>
          React.createElement("option", { key: option.value, value: option.value }, option.label),
        ),
      ),
      rowText({ hint, error }),
    ),
}));

import { PluginCatalogSync } from "@/plugins/catalog-sync";
import { SlpSettingsCard } from "./slp-settings-card";

const SWITCH = "settings.host.slp.enabled.label";
const MODEL = "settings.host.slp.supervisorModel.label";

let serverCounter = 0;

function renderCard(host: FakeSlpHost) {
  serverCounter += 1;
  const serverId = `host-${serverCounter}`;
  hostClients.set(serverId, host.client);
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <PluginCatalogSync serverId={serverId} client={host.client} />
      <SlpSettingsCard serverId={serverId} />
    </QueryClientProvider>,
  );
}

function ready(values: unknown, revision = "r1"): FakeSettingsRead {
  return { status: "ready", revision, values };
}

function switchInput() {
  return screen.getByLabelText<HTMLInputElement>(SWITCH);
}

function modelSelect() {
  return screen.getByLabelText<HTMLSelectElement>(MODEL);
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

describe("SLP card on the host Overview page", () => {
  it("does not render when the host has no slp plugin", async () => {
    const host = createFakeSlpHost({
      hasSlpPlugin: false,
      settings: ready({ enabled: true, supervisorModel: null }),
    });
    const { container } = renderCard(host);

    await expect.poll(() => host.catalogReads).toBe(1);
    await settle();
    expect(container.innerHTML).toBe("");
  });

  it("shows the stored switch and Supervisor model with their descriptions", async () => {
    const host = createFakeSlpHost({
      hasSlpPlugin: true,
      settings: ready({ enabled: false, supervisorModel: "claude-sonnet-4-5" }),
    });
    renderCard(host);

    const toggle = await screen.findByLabelText<HTMLInputElement>(SWITCH);
    expect(toggle.checked).toBe(false);
    expect(modelSelect().value).toBe("claude-sonnet-4-5");
    expect(screen.getByRole("region", { name: "settings.host.slp.title" })).toBeTruthy();
    expect(screen.getByText("settings.host.slp.enabled.hint")).toBeTruthy();
    expect(screen.getByText("settings.host.slp.supervisorModel.hint")).toBeTruthy();
  });

  it("offers the default plus the selectable claude models only", async () => {
    const host = createFakeSlpHost({
      hasSlpPlugin: true,
      settings: ready({ enabled: true, supervisorModel: null }),
    });
    renderCard(host);

    const select = await screen.findByLabelText<HTMLSelectElement>(MODEL);
    const options = [...select.options].map((option) => [option.value, option.label]);
    expect(options).toEqual([
      ["", "settings.host.slp.supervisorModel.default"],
      ["claude-opus-4-1", "Opus 4.1"],
      ["claude-sonnet-4-5", "Sonnet 4.5"],
    ]);
    expect(select.value).toBe("");
  });

  it("saves the flipped switch with the read revision and the stored model", async () => {
    const host = createFakeSlpHost({
      hasSlpPlugin: true,
      settings: ready({ enabled: true, supervisorModel: "claude-opus-4-1" }, "r4"),
    });
    renderCard(host);
    const toggle = await screen.findByLabelText<HTMLInputElement>(SWITCH);

    fireEvent.click(toggle);

    await expect
      .poll(() => host.writes)
      .toEqual([
        { revision: "r4", values: { enabled: false, supervisorModel: "claude-opus-4-1" } },
      ]);
    await expect.poll(() => switchInput().checked).toBe(false);
  });

  it("saves a null Supervisor model when the default is chosen", async () => {
    const host = createFakeSlpHost({
      hasSlpPlugin: true,
      settings: ready({ enabled: true, supervisorModel: "claude-opus-4-1" }, "r2"),
    });
    renderCard(host);
    const select = await screen.findByLabelText<HTMLSelectElement>(MODEL);

    fireEvent.change(select, { target: { value: "" } });

    await expect
      .poll(() => host.writes)
      .toEqual([{ revision: "r2", values: { enabled: true, supervisorModel: null } }]);
    await expect.poll(() => modelSelect().value).toBe("");
  });

  it("saves the chosen claude model", async () => {
    const host = createFakeSlpHost({
      hasSlpPlugin: true,
      settings: ready({ enabled: false, supervisorModel: null }, "r9"),
    });
    renderCard(host);
    const select = await screen.findByLabelText<HTMLSelectElement>(MODEL);

    fireEvent.change(select, { target: { value: "claude-sonnet-4-5" } });

    await expect
      .poll(() => host.writes)
      .toEqual([
        { revision: "r9", values: { enabled: false, supervisorModel: "claude-sonnet-4-5" } },
      ]);
  });

  it("shows SLP as enabled when the stored state is invalid", async () => {
    const host = createFakeSlpHost({
      hasSlpPlugin: true,
      settings: { status: "invalid", revision: "r1", error: "corrupt settings file" },
    });
    renderCard(host);

    const toggle = await screen.findByLabelText<HTMLInputElement>(SWITCH);
    expect(toggle.checked).toBe(true);
    expect(modelSelect().value).toBe("");
  });

  it("shows why a save failed and keeps the stored value", async () => {
    const host = createFakeSlpHost({
      hasSlpPlugin: true,
      settings: ready({ enabled: true, supervisorModel: null }),
    });
    host.rejectNextWrite({ status: "conflict", error: "Settings changed on the host" });
    renderCard(host);
    const toggle = await screen.findByLabelText<HTMLInputElement>(SWITCH);

    fireEvent.click(toggle);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Settings changed on the host");
    expect(switchInput().checked).toBe(true);
  });

  it("shows a value saved elsewhere while the page stays open", async () => {
    const host = createFakeSlpHost({
      hasSlpPlugin: true,
      settings: ready({ enabled: true, supervisorModel: null }),
    });
    renderCard(host);
    await screen.findByLabelText(SWITCH);

    host.changeSettingsElsewhere(
      ready({ enabled: false, supervisorModel: "claude-opus-4-1" }, "r5"),
    );

    await expect.poll(() => switchInput().checked).toBe(false);
    await expect.poll(() => modelSelect().value).toBe("claude-opus-4-1");
  });

  it("shows a failed read instead of the controls", async () => {
    const host = createFakeSlpHost({
      hasSlpPlugin: true,
      settings: new Error("settings rpc unavailable"),
    });
    renderCard(host);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("settings rpc unavailable");
    expect(screen.queryByLabelText(SWITCH)).toBeNull();
  });
});
