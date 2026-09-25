/**
 * @vitest-environment jsdom
 */
import { renderHook } from "@testing-library/react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { useSessionStore, type Agent } from "@/stores/session-store";
import {
  getLastWorkspaceSelection,
  hydrateLastWorkspaceSelection,
  useActiveWorkspaceSelection,
} from "./index";

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

const pathnameState = vi.hoisted(() => ({ value: "/" }));

vi.mock("expo-router", () => ({
  router: { navigate: vi.fn(), dismissTo: vi.fn() },
  useLocalSearchParams: () => ({}),
  usePathname: () => pathnameState.value,
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

const SERVER_ID = "server-route-hook";

const AGENT_TIMESTAMP = new Date("2026-09-01T00:00:00.000Z");

function supervisorAgent(workspaceId: string): Agent {
  return {
    serverId: SERVER_ID,
    id: "agent-supervisor",
    provider: "claude",
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt: AGENT_TIMESTAMP,
    updatedAt: AGENT_TIMESTAMP,
    lastUserMessageAt: null,
    lastActivityAt: AGENT_TIMESTAMP,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    runtimeInfo: undefined,
    lastUsage: undefined,
    lastError: null,
    title: "Supervisor",
    cwd: "/tmp/paseo-home/supervisor",
    workspaceId,
    model: null,
    features: undefined,
    thinkingOptionId: undefined,
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: null,
    parentAgentId: null,
    labels: { "slp.role": "supervisor" },
    projectPlacement: null,
  };
}

describe("useActiveWorkspaceSelection", () => {
  beforeAll(async () => {
    await hydrateLastWorkspaceSelection();
    const store = useSessionStore.getState();
    store.initializeSession(SERVER_ID, null as unknown as DaemonClient);
    store.setAgents(
      SERVER_ID,
      new Map([["agent-supervisor", supervisorAgent("workspace-supervisor")]]),
    );
  });

  it("keeps the last ordinary workspace when the route shows the Supervisor workspace", () => {
    pathnameState.value = `/h/${SERVER_ID}/workspace/workspace-a`;
    const { result, rerender } = renderHook(() => useActiveWorkspaceSelection());
    expect(getLastWorkspaceSelection()).toEqual({
      serverId: SERVER_ID,
      workspaceId: "workspace-a",
    });

    pathnameState.value = `/h/${SERVER_ID}/workspace/workspace-supervisor`;
    rerender();

    expect(result.current).toEqual({ serverId: SERVER_ID, workspaceId: "workspace-supervisor" });
    expect(getLastWorkspaceSelection()).toEqual({
      serverId: SERVER_ID,
      workspaceId: "workspace-a",
    });
  });
});
