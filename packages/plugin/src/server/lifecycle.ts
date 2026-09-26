import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentTimelineItem,
  AgentSessionConfig,
} from "@getpaseo/protocol/agent-types";
import type { PaseoApi } from "@getpaseo/client";
import type { WorkspaceCreateRequest } from "@getpaseo/protocol/messages";
import type { ProviderPaseoToolsPolicy } from "@getpaseo/protocol/provider-config";

export interface PluginHookContext {
  paseo: PaseoApi;
  signal: AbortSignal;
}

export interface PluginHookWorkspace {
  id: string;
  projectId: string;
  cwd: string;
  name: string | null;
  archivedAt: string | null;
}

export interface PluginHookAgent {
  id: string;
  workspaceId: string | null;
  parentAgentId: string | null;
  provider: string;
  cwd: string;
  title: string | null;
  /** The agent's labels when the event fired. `parentAgentId` mirrors `paseo.parent-agent-id`. */
  labels?: Record<string, string>;
}

export interface PluginSessionOpenRequest {
  agentId: string;
  workspaceId: string | null;
  provider: string;
  cwd: string;
  reason: "create" | "resume" | "refresh" | "import";
  purpose: "interactive" | "history";
  env: Record<string, string>;
}

export type PluginTurnOutcome =
  | { kind: "completed" }
  | { kind: "failed"; error: { message: string; code?: string } }
  | { kind: "canceled"; reason: string };

export interface PluginLifecycleEvents {
  "agent.turn_started": { agent: PluginHookAgent; turnId: string | null };
  "agent.turn_ended": {
    agent: PluginHookAgent;
    turnId: string | null;
    outcome: PluginTurnOutcome;
    timeline: readonly AgentTimelineItem[];
  };
  "agent.permission_requested": { agent: PluginHookAgent; request: AgentPermissionRequest };
  "agent.permission_resolved": {
    agent: PluginHookAgent;
    requestId: string;
    resolution: AgentPermissionResponse;
  };
  "agent.archived": { agent: PluginHookAgent; archivedAt: string };
  "agent.created": { agent: PluginHookAgent };
  "workspace.created": { workspace: PluginHookWorkspace };
  "workspace.archived": { workspace: PluginHookWorkspace };
}

export interface PluginBeforeRequests {
  "agent.create": {
    config: AgentSessionConfig;
    env?: Record<string, string>;
    /**
     * Labels the agent registers with. Omit to keep the labels you received. The daemon owns
     * `paseo.parent-agent-id`: setting or removing it here has no effect.
     */
    labels?: Record<string, string>;
    /**
     * Paseo tools to turn off for this agent only, on top of the provider's `paseoTools` policy.
     * Cuts only add up: a tool disabled by the provider or by an earlier hook stays disabled, and
     * `enabled: true` does not undo an `enabled: false`. Omit to keep what you received. The
     * result is frozen into the agent record at creation; resume and reload do not run hooks.
     */
    paseoTools?: ProviderPaseoToolsPolicy;
  };
  "agent.session_open": PluginSessionOpenRequest;
  "workspace.create": Omit<WorkspaceCreateRequest, "type" | "requestId">;
}

export interface PluginLifecycleRegistration {
  on<Name extends keyof PluginLifecycleEvents>(
    name: Name,
    handler: (
      event: PluginLifecycleEvents[Name],
      context: PluginHookContext,
    ) => void | Promise<void>,
  ): () => void;
  before<Name extends keyof PluginBeforeRequests>(
    name: Name,
    handler: (
      input: { request: PluginBeforeRequests[Name] },
      context: PluginHookContext,
    ) => PluginBeforeRequests[Name] | void | Promise<PluginBeforeRequests[Name] | void>,
  ): () => void;
}
