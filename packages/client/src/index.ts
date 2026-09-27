import type { OwnedSubscription } from "./connection/index.js";
export type { OwnedSubscription, SubscriptionObserver } from "./connection/index.js";
import type { DaemonClientConfig } from "./daemon-client.js";
import type { AgentPermissionResponse } from "@alp/protocol/agent-types";
import type {
  AgentSnapshotPayload,
  CreationSnapshot,
  CreateAgentRequestMessage,
  FetchWorkspacesRequestMessage,
  FetchWorkspacesResponseMessage,
  GetProvidersSnapshotResponseMessage,
  ListAvailableProvidersResponse,
  ListCommandsResponse,
  ListProviderFeaturesRequestMessage,
  ListProviderFeaturesResponseMessage,
  ListProviderModelsResponseMessage,
  ProjectListRequestMessage,
  ProjectListResponseMessage,
  ListProviderModesResponseMessage,
  MutableDaemonConfig,
  MutableDaemonConfigPatch,
  ProviderDiagnosticResponseMessage,
  ProviderUsageListResponseMessage,
  ProjectPlacementPayload,
  WorkspaceProjectDescriptorPayload,
  RefreshProvidersSnapshotResponseMessage,
  SendAgentMessageRequest,
  SessionOutboundMessage,
  WorkspaceDescriptorPayload,
  WorkspaceCreateRequest,
} from "@alp/protocol/messages";
import { DaemonClient, type CreateAgentRequestOptions } from "./daemon-client.js";
import {
  createTerminalActions,
  type AlpTerminalActions,
  type AlpWorkspaceTerminalActions,
} from "./terminals/index.js";
export type {
  AlpTerminal,
  AlpTerminalActions,
  AlpTerminalHandle,
  AlpTerminalCreateOptions,
  AlpTerminalListOptions,
  AlpTerminalListResult,
  AlpTerminalCaptureOptions,
  AlpTerminalCaptureResult,
  AlpWorkspaceTerminalActions,
} from "./terminals/index.js";
import type { PluginTimelineItem } from "@alp/protocol/agent-types";
import type {
  FetchAgentsEntry,
  FetchAgentsOptions,
  FetchAgentsPageInfo,
  FetchAgentTimelineCursor,
  FetchAgentTimelineDirection,
  FetchAgentTimelinePayload,
  FetchAgentTimelineProjection,
  WaitForFinishResult,
} from "./daemon-client.js";

/**
 * Coding turns routinely run for minutes, so the handle waits far longer than
 * the transport's own conservative default.
 */
const DEFAULT_WAIT_FOR_FINISH_MS = 10 * 60_000;

export type ConnectionState =
  | { status: "idle" }
  | { status: "connecting"; attempt: number }
  | { status: "connected" }
  | { status: "disconnected"; reason?: string }
  | { status: "disposed" };

export interface AlpLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface AlpClientConfig {
  capabilities?: DaemonClientConfig["capabilities"];
  url: string;
  clientId?: string;
  appVersion?: string;
  runtimeGeneration?: number | null;
  password?: string;
  authHeader?: string;
  suppressSendErrors?: boolean;
  logger?: AlpLogger;
  connectTimeoutMs?: number;
  e2ee?: {
    enabled?: boolean;
    daemonPublicKeyB64?: string;
  };
  reconnect?: {
    enabled?: boolean;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
  runtimeMetricsIntervalMs?: number;
  runtimeMetricsWindowMs?: number;
}

export type AlpWorkspace = WorkspaceDescriptorPayload;
export type AlpAgent = AgentSnapshotPayload;
export type AlpAgentListOptions = FetchAgentsOptions;
export type AlpProject = WorkspaceProjectDescriptorPayload;
export type AlpProjectListOptions = Omit<ProjectListRequestMessage, "type" | "requestId"> & {
  requestId?: string;
};
export type AlpProjectListResult = ProjectListResponseMessage["payload"];
export type AlpProjectUpdate = Extract<
  SessionOutboundMessage,
  { type: "project.update" }
>["payload"];
export type AlpProjectUpdateHandler = (update: AlpProjectUpdate) => void;

export interface AlpAgentListResult {
  subscription?: OwnedSubscription<AlpAgentListResult>;
  requestId: string;
  subscriptionId?: string | null;
  entries: FetchAgentsEntry[];
  pageInfo: FetchAgentsPageInfo;
}
export type AlpWorkspaceListOptions = Omit<FetchWorkspacesRequestMessage, "type" | "requestId"> & {
  requestId?: string;
};

export interface AlpWorkspaceListResult {
  subscription?: OwnedSubscription<AlpWorkspaceListResult>;
  requestId: string;
  subscriptionId?: string | null;
  entries: AlpWorkspace[];
  pageInfo: FetchWorkspacesResponseMessage["payload"]["pageInfo"];
}

export interface AlpWorkspaceOpenOptions {
  cwd: string;
  requestId?: string;
}

export type AlpWorkspaceCreateOptions = Omit<
  WorkspaceCreateRequest,
  "type" | "requestId" | "agent" | "subscribe"
> & {
  requestId?: string;
  agent?: Omit<
    AlpAgentCreateOptions,
    "worktree" | "git" | "onEvent" | "idempotencyKey" | "requestId"
  >;
  onEvent?: (snapshot: CreationSnapshot) => void;
};

export interface AlpWorkspaceArchiveResult {
  requestId: string;
  workspaceId: string;
  archivedAt: string | null;
  error: string | null;
}

export type AlpWorkspaceUpdate = Extract<
  SessionOutboundMessage,
  { type: "workspace_update" }
>["payload"];

export type AlpWorkspaceUpdateHandler = (update: AlpWorkspaceUpdate) => void;

export interface AlpWorkspaceHandle {
  readonly id: string;
  readonly projectId: string | null;
  readonly directory: string | null;
  readonly name: string | null;
  readonly status: AlpWorkspace["status"] | null;
  readonly agents: {
    create(options: AlpWorkspaceAgentCreateOptions): Promise<AlpAgentHandle>;
  };
  readonly terminals: AlpWorkspaceTerminalActions;
  current(): AlpWorkspace | null;
  refresh(options?: { requestId?: string }): Promise<AlpWorkspace | null>;
  setTitle(title: string | null, requestId?: string): Promise<{ title: string | null }>;
  archive(requestId?: string): Promise<AlpWorkspaceArchiveResult>;
  /**
   * Subscribes to already-emitted daemon workspace_update events for this id.
   * This returns a local unsubscribe function; it does not own app cache state or
   * send a daemon unsubscribe RPC. Call `workspaces.list({ subscribe: {} })` when
   * the daemon should start streaming workspace directory updates.
   */
  subscribe(handler: (update: AlpWorkspaceUpdate) => void): () => void;
}

export interface AlpProjectActions {
  list(options?: AlpProjectListOptions): Promise<AlpProjectListResult>;
  subscribe(handler: AlpProjectUpdateHandler): () => void;
}

export interface AlpWorkspaceActions {
  list(options: AlpWorkspaceListOptions & { subscribe: {} }): Promise<
    AlpWorkspaceListResult & {
      subscriptionId: string;
      subscription: OwnedSubscription<AlpWorkspaceListResult>;
    }
  >;
  list(options?: AlpWorkspaceListOptions): Promise<AlpWorkspaceListResult>;
  ref(workspace: string | AlpWorkspace): AlpWorkspaceHandle;
  open(input: string | AlpWorkspaceOpenOptions, requestId?: string): Promise<AlpWorkspaceHandle>;
  create(options: AlpWorkspaceCreateOptions): Promise<AlpWorkspaceHandle>;
  archive(
    workspace: string | AlpWorkspaceHandle,
    requestId?: string,
  ): Promise<AlpWorkspaceArchiveResult>;
  /**
   * Local event subscription over the low-level driver's workspace_update stream.
   * The returned function only removes this SDK listener.
   */
  subscribe(handler: AlpWorkspaceUpdateHandler): () => void;
}

type AlpAgentSessionConfig = CreateAgentRequestMessage["config"];
export type AlpAgentProvider = AlpAgentSessionConfig["provider"];

export type AlpProviderFeatureValues = Record<string, unknown>;

export interface AlpAgentConfig {
  /** Provider and model in `provider/model` format. */
  provider: string;
  modeId?: AlpAgentSessionConfig["modeId"];
  thinkingOptionId?: AlpAgentSessionConfig["thinkingOptionId"];
  featureValues?: AlpProviderFeatureValues;
  /** JSON-safe provider-native settings, validated by the selected provider. */
  options?: AlpAgentSessionConfig["providerOptions"];
  systemPrompt?: AlpAgentSessionConfig["systemPrompt"];
  toolPolicy?: AlpAgentSessionConfig["toolPolicy"];
  mcpServers?: AlpAgentSessionConfig["mcpServers"];
}

export interface AlpAgentCreateOptions {
  idempotencyKey?: string;
  agentId?: string;
  onEvent?: (snapshot: CreationSnapshot) => void;
  config: AlpAgentConfig;
  cwd: string;
  parent?: string | AlpAgentHandle;
  title?: AlpAgentSessionConfig["title"];
  env?: CreateAgentRequestMessage["env"];
  prompt?: string;
  clientMessageId?: string;
  outputSchema?: Record<string, unknown>;
  images?: CreateAgentRequestMessage["images"];
  attachments?: CreateAgentRequestMessage["attachments"];
  git?: CreateAgentRequestMessage["git"];
  worktree?: CreateAgentRequestMessage["worktree"];
  autoArchive?: CreateAgentRequestMessage["autoArchive"];
  requestId?: string;
  labels?: Record<string, string>;
}

export type AlpWorkspaceAgentCreateOptions = Omit<AlpAgentCreateOptions, "cwd">;

export interface AlpAgentRefetchResult {
  agent: AlpAgent;
  project: ProjectPlacementPayload | null;
}

export interface AlpAgentTimelineRefetchOptions {
  direction?: FetchAgentTimelineDirection;
  cursor?: FetchAgentTimelineCursor;
  limit?: number;
  projection?: FetchAgentTimelineProjection;
  requestId?: string;
}

export interface AlpAgentSendOptions {
  messageId?: string;
  images?: Array<{ data: string; mimeType: string }>;
  attachments?: SendAgentMessageRequest["attachments"];
}

export interface AlpAgentRunOptions extends AlpAgentSendOptions {
  timeoutMs?: number;
}

export type AlpAgentRunResult = WaitForFinishResult;
export type AlpAgentPermissionResponse = AgentPermissionResponse;

export interface AlpAgentRespondToPermissionOptions {
  requestId: string;
  response: AlpAgentPermissionResponse;
}

export interface AlpAgentCommandsOptions {
  requestId?: string;
}

export type AlpAgentCommandsResult = ListCommandsResponse["payload"];

export type AlpAgentUpdate = Extract<SessionOutboundMessage, { type: "agent_update" }>["payload"];

export type AlpAgentStream = Extract<SessionOutboundMessage, { type: "agent_stream" }>["payload"];

export type AlpAgentUpdateHandler = (update: AlpAgentUpdate) => void;

export type AlpAgentTimelineEvent =
  | AlpAgentStream
  | {
      agentId: string;
      event: { type: "replacement"; epoch: string };
    }
  | {
      agentId: string;
      subscriptionId: string;
      event: { type: "subscription_restored" };
    }
  | { agentId: string; event: { type: "error"; error: string } };

export type AlpAgentTimelineSubscription = ReturnType<DaemonClient["subscribeAgentTimeline"]>;

export interface AlpAgentTimelineHandle {
  append(item: Omit<PluginTimelineItem, "pluginId">): Promise<{ seq: number; epoch: string }>;
  /**
   * Fetches a fresh timeline page through the existing daemon RPC. If the daemon
   * includes an agent snapshot in the response, the parent handle is updated to
   * that value.
   */
  refetch(options?: AlpAgentTimelineRefetchOptions): Promise<FetchAgentTimelinePayload>;
  /**
   * Delivers live events only. After reconnect, subscription_restored precedes
   * subsequent updates. History may have been missed; use refetch() to request
   * the range you need. No history is fetched automatically. A replacement event
   * invalidates the previous epoch. Subscription errors release this observation.
   * Await the returned unsubscribe function's `ready` promise before starting
   * work that must be observed. It rejects if establishment fails.
   */
  subscribe(handler: (event: AlpAgentTimelineEvent) => void): AlpAgentTimelineSubscription;
}

export interface AlpAgentHandle {
  readonly id: string;
  /**
   * `workspaceId` through `archivedAt` mirror the last snapshot this handle
   * observed. A handle from `ref()` reads `null` for all of them until
   * `refresh()`, `run()`, `waitForFinish()`, a timeline refetch, or
   * `subscribe()` delivers a snapshot. Optional snapshot values also read as
   * `null`; use `current()` when you need to distinguish those states.
   */
  readonly workspaceId: string | null;
  readonly cwd: string | null;
  readonly status: AlpAgent["status"] | null;
  readonly capabilities: AlpAgent["capabilities"] | null;
  readonly availableModes: AlpAgent["availableModes"] | null;
  readonly pendingPermissions: AlpAgent["pendingPermissions"] | null;
  readonly activeTurn: NonNullable<AlpAgent["activeTurn"]> | null;
  readonly lastUsage: NonNullable<AlpAgent["lastUsage"]> | null;
  readonly lastError: NonNullable<AlpAgent["lastError"]> | null;
  readonly features: NonNullable<AlpAgent["features"]> | null;
  readonly runtimeInfo: NonNullable<AlpAgent["runtimeInfo"]> | null;
  readonly archivedAt: NonNullable<AlpAgent["archivedAt"]> | null;
  readonly timeline: AlpAgentTimelineHandle;
  current(): AlpAgent | null;
  refresh(requestId?: string): Promise<AlpAgentRefetchResult | null>;
  send(text: string, options?: AlpAgentSendOptions): Promise<void>;
  respondToPermission(options: AlpAgentRespondToPermissionOptions): Promise<void>;
  /** Sends a prompt and resolves when that turn finishes or needs attention. */
  run(text: string, options?: AlpAgentRunOptions): Promise<AlpAgentRunResult>;
  /** Waits for the current turn, including one started with `prompt`. */
  waitForFinish(timeoutMs?: number): Promise<AlpAgentRunResult>;
  /**
   * Asks the running session for the slash commands and skills it actually
   * loaded. Providers answer from the live session, so this sees built-in and
   * bundled entries that no directory scan can find. The payload carries its own
   * `error` string; a provider that cannot answer reports it there rather than
   * rejecting.
   */
  commands(options?: AlpAgentCommandsOptions): Promise<AlpAgentCommandsResult>;
  archive(): Promise<{ archivedAt: string }>;
  detach(): Promise<void>;
  subscribe(handler: (update: AlpAgentUpdate) => void): () => void;
}

export interface AlpAgentActions {
  list(options: AlpAgentListOptions & { subscribe: {} }): Promise<
    AlpAgentListResult & {
      subscriptionId: string;
      subscription: OwnedSubscription<AlpAgentListResult>;
    }
  >;
  list(options?: AlpAgentListOptions): Promise<AlpAgentListResult>;
  ref(agent: string | AlpAgent): AlpAgentHandle;
  create(options: AlpAgentCreateOptions): Promise<AlpAgentHandle>;
  /**
   * Local event subscription over the low-level driver's agent_update stream.
   * The returned function only removes this SDK listener.
   */
  subscribe(handler: AlpAgentUpdateHandler): () => void;
}

export type AlpProviderModelsResult = ListProviderModelsResponseMessage["payload"];
export type AlpProviderModesResult = ListProviderModesResponseMessage["payload"];
type AlpProviderFeaturesDraft = ListProviderFeaturesRequestMessage["draftConfig"];
export interface AlpProviderFeaturesInput extends Omit<
  AlpProviderFeaturesDraft,
  "provider" | "model"
> {
  /** Provider and model in `provider/model` format. */
  provider: string;
}
export type AlpProviderFeaturesResult = ListProviderFeaturesResponseMessage["payload"];
export type AlpProviderAvailabilityResult = ListAvailableProvidersResponse["payload"];
export type AlpProviderSnapshotResult = GetProvidersSnapshotResponseMessage["payload"];
export type AlpProviderSnapshotUpdate = Extract<
  SessionOutboundMessage,
  { type: "providers_snapshot_update" }
>["payload"];
export type AlpProviderRefreshResult = RefreshProvidersSnapshotResponseMessage["payload"];
export type AlpProviderDiagnosticResult = ProviderDiagnosticResponseMessage["payload"];
export type AlpProviderUsageResult = ProviderUsageListResponseMessage["payload"];
export interface AlpProviderUsageOptions {
  requestId?: string;
}

export interface AlpProviderListOptions {
  cwd?: string;
  requestId?: string;
}

export interface AlpProviderRefreshOptions {
  cwd?: string;
  providers?: AlpAgentProvider[];
  requestId?: string;
}

export interface AlpProviderWaitOptions extends AlpProviderListOptions {
  timeoutMs?: number;
}

export interface AlpProviderActions {
  listModels(
    provider: AlpAgentProvider,
    options?: AlpProviderListOptions,
  ): Promise<AlpProviderModelsResult>;
  listModes(
    provider: AlpAgentProvider,
    options?: AlpProviderListOptions,
  ): Promise<AlpProviderModesResult>;
  listFeatures(
    draftConfig: AlpProviderFeaturesInput,
    options?: { requestId?: string },
  ): Promise<AlpProviderFeaturesResult>;
  listAvailable(options?: { requestId?: string }): Promise<AlpProviderAvailabilityResult>;
  snapshot(options?: AlpProviderListOptions): Promise<AlpProviderSnapshotResult>;
  /** Resolves after the daemon's lazy provider discovery has finished. */
  waitForReady(options?: AlpProviderWaitOptions): Promise<AlpProviderSnapshotResult>;
  refresh(options?: AlpProviderRefreshOptions): Promise<AlpProviderRefreshResult>;
  diagnostic(
    provider: AlpAgentProvider,
    options?: { requestId?: string },
  ): Promise<AlpProviderDiagnosticResult>;
  listUsage(options?: AlpProviderUsageOptions): Promise<AlpProviderUsageResult>;
  subscribe(handler: (update: AlpProviderSnapshotUpdate) => void): () => void;
}

export interface AlpConfigActions {
  /**
   * Reads daemon config through the existing config RPC. Provider profiles,
   * custom provider entries, keys/env, custom binaries, and provider enablement
   * are currently config-file-shaped daemon state, so the SDK exposes this raw
   * typed surface instead of pretending there are higher-level provider-settings
   * RPCs.
   */
  get(requestId?: string): Promise<{ requestId: string; config: MutableDaemonConfig }>;
  /**
   * Patches daemon config through the existing config RPC. The daemon validates
   * and persists supported fields; unsupported provider/settings workflows remain
   * daemon gaps until first-class RPCs exist.
   */
  patch(
    config: MutableDaemonConfigPatch,
    requestId?: string,
  ): Promise<{ requestId: string; config: MutableDaemonConfig }>;
}

// ALP(slp): lets one plugin call another plugin's RPC over the existing plugin RPC request.
export interface AlpPluginActions {
  /**
   * Invokes `method` on plugin `pluginId` and resolves with its raw output. The target plugin
   * validates the input; validate the output yourself. Rejects when the plugin is not running.
   */
  invoke(pluginId: string, method: string, input: unknown): Promise<unknown>;
}

export interface AlpApi {
  dispose(): Promise<void>;
  observeEvents: DaemonClient["observeEvents"];
  readonly terminals: AlpTerminalActions;
  readonly workspaces: AlpWorkspaceActions;
  readonly projects: AlpProjectActions;
  readonly agents: AlpAgentActions;
  readonly providers: AlpProviderActions;
  readonly config: AlpConfigActions;
  readonly plugins: AlpPluginActions;
}

export interface AlpClient extends AlpApi {
  connect(): Promise<void>;
  close(): Promise<void>;
  ensureConnected(): void;
  getConnectionState(): ConnectionState;
}

export function createAlpClient(config: AlpClientConfig): AlpClient {
  const daemonClient = new DaemonClient({
    ...config,
    clientId: config.clientId ?? createGeneratedClientId(),
    clientType: "cli",
  });
  const api = createAlpApi(daemonClient);
  return {
    ...api,
    connect: () => daemonClient.connect(),
    close: async () => {
      try {
        await api.dispose();
      } finally {
        await daemonClient.close();
      }
    },
    ensureConnected: () => daemonClient.ensureConnected(),
    getConnectionState: () => daemonClient.getConnectionState(),
  };
}

function toDaemonAgentCreateOptions(
  options: AlpAgentCreateOptions,
  placement?: { workspaceId: string; cwd: string },
): CreateAgentRequestOptions {
  const { config: agentConfig, cwd, parent, title, prompt, ...requestOptions } = options;
  const { provider: providerModel, options: providerOptions, ...runtimeConfig } = agentConfig;
  const { provider, model } = parseProviderModel(providerModel);
  return {
    ...requestOptions,
    config: {
      ...runtimeConfig,
      provider,
      model,
      cwd: placement?.cwd ?? cwd,
      ...(title !== undefined ? { title } : {}),
      ...(providerOptions !== undefined ? { providerOptions } : {}),
    },
    ...(placement ? { workspaceId: placement.workspaceId } : {}),
    ...(parent ? { callerAgentId: resolveAgentId(parent) } : {}),
    ...(prompt !== undefined ? { initialPrompt: prompt } : {}),
  };
}

export function createAlpApi(
  daemonClient: DaemonClient,
  scopeOptions?: { signal?: AbortSignal },
): AlpApi {
  const handles = new Set<{ release(): Promise<void> }>();
  const agentListeners = new Set<AlpAgentUpdateHandler>();
  const workspaceListeners = new Set<AlpWorkspaceUpdateHandler>();
  const lifetime = new AbortController();
  const own = <T extends { release(): Promise<void> }>(create: () => T): T => {
    if (lifetime.signal.aborted) throw new Error("Alp API is disposed");
    const handle = create();
    handles.add(handle);
    const release = handle.release.bind(handle);
    handle.release = async () => {
      await release();
      handles.delete(handle);
    };
    return handle;
  };
  const listenAgents = (handler: AlpAgentUpdateHandler) => {
    if (lifetime.signal.aborted) throw new Error("Alp API is disposed");
    agentListeners.add(handler);
    return () => {
      agentListeners.delete(handler);
    };
  };
  const listenWorkspaces = (handler: AlpWorkspaceUpdateHandler) => {
    if (lifetime.signal.aborted) throw new Error("Alp API is disposed");
    workspaceListeners.add(handler);
    return () => {
      workspaceListeners.delete(handler);
    };
  };
  const createAgentHandle = createAgentHandleFactory(
    daemonClient,
    listenAgents,
    (agentId, handler) => own(() => daemonClient.subscribeAgentTimeline(agentId, handler)),
  );
  const createAgent = async (
    options: AlpAgentCreateOptions,
    placement?: { workspaceId: string; cwd: string },
  ) => {
    const agent = await daemonClient.createAgent(toDaemonAgentCreateOptions(options, placement));
    return createAgentHandle(agent);
  };
  const terminals = createTerminalActions(daemonClient, async (workspaceId) => {
    const workspace = await createWorkspaceHandle(workspaceId).refresh();
    if (!workspace?.workspaceDirectory) {
      throw new Error(`Workspace ${workspaceId} is not active or has no available directory`);
    }
    return workspace.workspaceDirectory;
  });
  const createWorkspaceHandle = createWorkspaceHandleFactory(
    daemonClient,
    createAgent,
    terminals,
    listenWorkspaces,
  );

  let disposal: Promise<void> | null = null;
  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    lifetime.abort();
    scopeOptions?.signal?.removeEventListener("abort", abort);
    agentListeners.clear();
    workspaceListeners.clear();
    disposal = Promise.allSettled([...handles].map((handle) => handle.release())).then(
      (results) => {
        handles.clear();
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length)
          throw new AggregateError(failures, "Failed to release API subscriptions");
        return undefined;
      },
    );
    return disposal;
  };
  const abort = () => {
    void dispose().catch((error) => console.error("API subscription cleanup failed", error));
  };
  if (scopeOptions?.signal?.aborted) abort();
  else scopeOptions?.signal?.addEventListener("abort", abort, { once: true });

  const observeEvents: DaemonClient["observeEvents"] = (events, options) =>
    own(() => daemonClient.observeEvents(events, options));

  const subscribeEvent = (
    event: "project.update" | "providers_snapshot_update",
    update: (message: SessionOutboundMessage) => void,
  ): (() => void) => {
    const observation = observeEvents([event]);
    observation.subscribe({ snapshot: () => {}, update });
    return () => {
      void observation
        .release()
        .catch((error) => console.error("Event subscription cleanup failed", error));
    };
  };

  function listWorkspaces(options: AlpWorkspaceListOptions & { subscribe: {} }): Promise<
    AlpWorkspaceListResult & {
      subscriptionId: string;
      subscription: OwnedSubscription<AlpWorkspaceListResult>;
    }
  >;
  function listWorkspaces(options?: AlpWorkspaceListOptions): Promise<AlpWorkspaceListResult>;
  async function listWorkspaces(
    options?: AlpWorkspaceListOptions,
  ): Promise<AlpWorkspaceListResult> {
    if (!options?.subscribe) return daemonClient.fetchWorkspaces(options);
    if (options.subscribe.subscriptionId !== undefined)
      throw new Error("Subscription IDs are assigned by the host");
    const subscription = own(() => daemonClient.observeWorkspaces(options));
    subscription.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (message.type === "workspace_update")
          for (const listener of workspaceListeners) listener(message.payload);
      },
    });
    return { ...(await subscription.ready), subscription };
  }

  function listAgents(options: AlpAgentListOptions & { subscribe: {} }): Promise<
    AlpAgentListResult & {
      subscriptionId: string;
      subscription: OwnedSubscription<AlpAgentListResult>;
    }
  >;
  function listAgents(options?: AlpAgentListOptions): Promise<AlpAgentListResult>;
  async function listAgents(options?: AlpAgentListOptions): Promise<AlpAgentListResult> {
    if (!options?.subscribe) return daemonClient.fetchAgents(options);
    if (options.subscribe.subscriptionId !== undefined)
      throw new Error("Subscription IDs are assigned by the host");
    const subscription = own(() => daemonClient.observeAgents(options));
    subscription.subscribe({
      snapshot: () => {},
      update: (message) => {
        if (message.type === "agent_update")
          for (const listener of agentListeners) listener(message.payload);
      },
    });
    return { ...(await subscription.ready), subscription };
  }

  return {
    dispose,
    observeEvents,
    terminals,
    projects: {
      list: (options) => daemonClient.listProjects(options),
      subscribe: (handler) => {
        return subscribeEvent("project.update", (message) => {
          if (message.type === "project.update") handler(message.payload);
        });
      },
    },
    workspaces: {
      list: listWorkspaces,
      ref: (workspace) => createWorkspaceHandle(workspace),
      open: (input, requestId) =>
        openWorkspace(daemonClient, createWorkspaceHandle, input, requestId),
      create: async ({ requestId, agent, ...options }) => {
        const result = await daemonClient.createWorkspace(
          { ...options, ...(agent ? { agent: toDaemonAgentCreateOptions(agent) } : {}) },
          requestId,
        );
        if (result.error || !result.workspace) {
          throw new Error(result.error ?? "The daemon did not create a workspace");
        }
        return createWorkspaceHandle(result.workspace);
      },
      archive: (workspace, requestId) =>
        daemonClient.archiveWorkspace(resolveWorkspaceId(workspace), requestId),
      subscribe: listenWorkspaces,
    },
    agents: {
      list: listAgents,
      ref: (agent) => createAgentHandle(agent),
      create: (options) => createAgent(options),
      subscribe: listenAgents,
    },
    providers: {
      listModels: (provider, options) => daemonClient.listProviderModels(provider, options),
      listModes: (provider, options) => daemonClient.listProviderModes(provider, options),
      listFeatures: ({ provider: providerModel, ...draftConfig }, options) => {
        const { provider, model } = parseProviderModel(providerModel);
        return daemonClient.listProviderFeatures({ ...draftConfig, provider, model }, options);
      },
      listAvailable: (options) => daemonClient.listAvailableProviders(options),
      snapshot: (options) => daemonClient.getProvidersSnapshot(options),
      waitForReady: (options) =>
        waitForProvidersReady(
          daemonClient,
          observeEvents(["providers_snapshot_update"]),
          lifetime.signal,
          options,
        ),
      refresh: (options) => daemonClient.refreshProvidersSnapshot(options),
      diagnostic: (provider, options) => daemonClient.getProviderDiagnostic(provider, options),
      listUsage: (options) => listProviderUsage(daemonClient, options),
      subscribe: (handler) => {
        return subscribeEvent("providers_snapshot_update", (message) => {
          if (message.type === "providers_snapshot_update") handler(message.payload);
        });
      },
    },
    config: {
      get: (requestId) => daemonClient.getDaemonConfig(requestId),
      patch: (patch, requestId) => daemonClient.patchDaemonConfig(patch, requestId),
    },
    // ALP(slp): plugin-to-plugin RPC, see AlpPluginActions.
    plugins: {
      invoke: (pluginId, method, input) => daemonClient.invokePluginRpc(pluginId, method, input),
    },
  };
}

type WorkspaceHandleFactory = (workspace: string | AlpWorkspace) => AlpWorkspaceHandle;
type AgentHandleFactory = (agent: string | AlpAgent) => AlpAgentHandle;
type CreateAgent = (
  options: AlpAgentCreateOptions,
  placement?: { workspaceId: string; cwd: string },
) => Promise<AlpAgentHandle>;

function createWorkspaceHandleFactory(
  daemonClient: DaemonClient,
  createAgent: CreateAgent,
  terminals: AlpTerminalActions,
  listen: (handler: AlpWorkspaceUpdateHandler) => () => void,
): WorkspaceHandleFactory {
  return (workspace) => {
    const id = typeof workspace === "string" ? workspace : workspace.id;
    let current = typeof workspace === "string" ? null : workspace;

    const refresh = async (options?: { requestId?: string }) => {
      let cursor: string | undefined;
      let requestId = options?.requestId;
      do {
        const result = await daemonClient.fetchWorkspaces({
          requestId,
          page: { limit: 200, ...(cursor ? { cursor } : {}) },
        });
        const match = result.entries.find((entry) => entry.id === id);
        if (match) {
          current = match;
          return current;
        }
        cursor = result.pageInfo.nextCursor ?? undefined;
        requestId = undefined;
      } while (cursor);
      current = null;
      return current;
    };

    return {
      id,
      get projectId() {
        return current?.projectId ?? null;
      },
      get directory() {
        return current?.workspaceDirectory ?? null;
      },
      get name() {
        return current?.name ?? null;
      },
      get status() {
        return current?.status ?? null;
      },
      agents: {
        create: async (options) => {
          const snapshot = current ?? (await refresh());
          if (!snapshot?.workspaceDirectory) {
            throw new Error(`Workspace ${id} has no available directory`);
          }
          return createAgent(
            { ...options, cwd: snapshot.workspaceDirectory },
            { workspaceId: id, cwd: snapshot.workspaceDirectory },
          );
        },
      },
      terminals: {
        create: (options) => terminals.create({ ...options, workspaceId: id }),
        list: (options) => terminals.list({ ...options, workspaceId: id }),
      },
      current: () => current,
      refresh,
      setTitle: (title, requestId) => daemonClient.setWorkspaceTitle(id, title, requestId),
      archive: async (requestId) => {
        const result = await daemonClient.archiveWorkspace(id, requestId);
        if (current) {
          current = { ...current, archivingAt: result.archivedAt };
        }
        return result;
      },
      subscribe: (handler) =>
        listen((update) => {
          if (update.kind === "upsert" && update.workspace.id === id) {
            current = update.workspace;
            handler(update);
          }
          if (update.kind === "remove" && update.id === id) {
            handler(update);
          }
        }),
    };
  };
}

function createAgentHandleFactory(
  daemonClient: DaemonClient,
  listen: (handler: AlpAgentUpdateHandler) => () => void,
  subscribeTimeline: DaemonClient["subscribeAgentTimeline"],
): AgentHandleFactory {
  return (agent) => {
    const id = typeof agent === "string" ? agent : agent.id;
    let current = typeof agent === "string" ? null : agent;

    const handle: AlpAgentHandle = {
      id,
      timeline: {
        append: (item) => daemonClient.appendAgentTimelineItem(id, item),
        refetch: async (options) => {
          const result = await daemonClient.fetchAgentTimeline(id, options);
          if (result.agent) {
            current = result.agent;
          }
          return result;
        },
        subscribe: (handler) =>
          subscribeTimeline(id, (message) => {
            switch (message.type) {
              case "agent_stream":
                return handler(message.payload);
              case "agent.timeline.subscription_restored":
                return handler({
                  agentId: id,
                  subscriptionId: message.payload.subscriptionId,
                  event: { type: "subscription_restored" },
                });
              case "agent.timeline.error":
                return handler({
                  agentId: id,
                  event: { type: "error", error: message.payload.error },
                });
              case "agent.timeline.replacement":
                return handler({
                  agentId: id,
                  event: { type: "replacement", epoch: message.payload.epoch },
                });
            }
          }),
      },
      get workspaceId() {
        return current?.workspaceId ?? null;
      },
      get cwd() {
        return current?.cwd ?? null;
      },
      get status() {
        return current?.status ?? null;
      },
      get capabilities() {
        return current?.capabilities ?? null;
      },
      get availableModes() {
        return current?.availableModes ?? null;
      },
      get pendingPermissions() {
        return current?.pendingPermissions ?? null;
      },
      get activeTurn() {
        return current?.activeTurn ?? null;
      },
      get lastUsage() {
        return current?.lastUsage ?? null;
      },
      get lastError() {
        return current?.lastError ?? null;
      },
      get features() {
        return current?.features ?? null;
      },
      get runtimeInfo() {
        return current?.runtimeInfo ?? null;
      },
      get archivedAt() {
        return current?.archivedAt ?? null;
      },
      current: () => current,
      refresh: async (requestId) => {
        const result = await daemonClient.fetchAgent({ agentId: id, requestId });
        current = result?.agent ?? null;
        return result;
      },
      send: async (text, options) => {
        await daemonClient.sendAgentMessage(id, text, options);
      },
      respondToPermission: async ({ requestId, response }) => {
        await daemonClient.respondToPermission(id, requestId, response);
      },
      run: async (text, options) => {
        const { timeoutMs, ...sendOptions } = options ?? {};
        await daemonClient.sendAgentMessage(id, text, sendOptions);
        const result = await daemonClient.waitForFinish(
          id,
          timeoutMs ?? DEFAULT_WAIT_FOR_FINISH_MS,
        );
        if (result.final) {
          current = result.final;
        }
        return result;
      },
      waitForFinish: async (timeoutMs) => {
        const result = await daemonClient.waitForFinish(
          id,
          timeoutMs ?? DEFAULT_WAIT_FOR_FINISH_MS,
        );
        if (result.final) {
          current = result.final;
        }
        return result;
      },
      commands: (options) => daemonClient.listCommands({ agentId: id, ...options }),
      archive: async () => {
        const result = await daemonClient.archiveAgent(id);
        if (current) {
          current = { ...current, archivedAt: result.archivedAt };
        }
        return result;
      },
      detach: async () => {
        await daemonClient.detachAgent(id);
      },
      subscribe: (handler) =>
        listen((update) => {
          if (update.kind === "upsert" && update.agent.id === id) {
            current = update.agent;
            handler(update);
          }
          if (update.kind === "remove" && update.agentId === id) {
            handler(update);
          }
        }),
    };

    return handle;
  };
}

async function openWorkspace(
  daemonClient: DaemonClient,
  createWorkspaceHandle: WorkspaceHandleFactory,
  input: string | AlpWorkspaceOpenOptions,
  requestId?: string,
): Promise<AlpWorkspaceHandle> {
  const options = typeof input === "string" ? { cwd: input, requestId } : input;
  const result = await daemonClient.openProject(options.cwd, options.requestId);
  if (result.error || !result.workspace) {
    throw new Error(result.error ?? `The daemon did not open a workspace for ${options.cwd}`);
  }
  return createWorkspaceHandle(result.workspace);
}

function resolveWorkspaceId(workspace: string | AlpWorkspaceHandle): string {
  return typeof workspace === "string" ? workspace : workspace.id;
}

function resolveAgentId(agent: string | AlpAgentHandle): string {
  return typeof agent === "string" ? agent : agent.id;
}

function parseProviderModel(selection: string): { provider: string; model: string } {
  const separator = selection.indexOf("/");
  if (separator <= 0 || separator === selection.length - 1) {
    throw new Error('Expected config.provider in "provider/model" format');
  }
  return {
    provider: selection.slice(0, separator),
    model: selection.slice(separator + 1),
  };
}

function listProviderUsage(
  daemonClient: DaemonClient,
  options?: AlpProviderUsageOptions,
): Promise<AlpProviderUsageResult> {
  // COMPAT(providerUsageList): added in v0.1.98, remove after 2027-02-28 once daemon floor >= v0.1.98.
  if (daemonClient.getLastServerInfoMessage()?.features?.providerUsageList !== true) {
    return Promise.reject(new Error("Update the host to list provider usage."));
  }
  return daemonClient.listProviderUsage(options);
}

async function waitForProvidersReady(
  daemonClient: DaemonClient,
  observation: ReturnType<DaemonClient["observeEvents"]>,
  signal: AbortSignal,
  options: AlpProviderWaitOptions = {},
): Promise<AlpProviderSnapshotResult> {
  const { timeoutMs = 60_000, ...snapshotOptions } = options;

  try {
    await observation.ready;
    signal.throwIfAborted();
    return await new Promise<AlpProviderSnapshotResult>((resolve, reject) => {
      let settled = false;
      let requestId: string | null = null;
      let snapshotCwd: string | undefined;
      const pendingUpdates = new Map<string | undefined, AlpProviderSnapshotUpdate>();
      let latestEntries: AlpProviderSnapshotResult["entries"] = [];

      const cleanup = () => {
        clearTimeout(timeout);
        unsubscribe();
        signal.removeEventListener("abort", abort);
      };
      const finish = (snapshot: AlpProviderSnapshotResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(snapshot);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      const updateMatches = (update: AlpProviderSnapshotUpdate) => update.cwd === snapshotCwd;

      const unsubscribe = observation.subscribe({
        snapshot: () => {},
        update: (message) => {
          if (message.type !== "providers_snapshot_update") return;
          const update = message.payload;
          if (!requestId) {
            pendingUpdates.set(update.cwd, update);
            return;
          }
          if (!updateMatches(update)) return;
          latestEntries = update.entries;
          if (update.entries.some((entry) => entry.status === "loading")) return;
          finish({ ...update, requestId });
        },
      });
      const abort = () => fail(new Error("Alp API is disposed"));
      signal.addEventListener("abort", abort, { once: true });

      const timeout = setTimeout(() => {
        const loading = latestEntries
          .filter((entry) => entry.status === "loading")
          .map((entry) => entry.provider)
          .join(", ");
        fail(
          new Error(
            loading
              ? `Timed out waiting for providers: ${loading}`
              : "Timed out waiting for provider discovery",
          ),
        );
      }, timeoutMs);

      void daemonClient
        .getProvidersSnapshot(snapshotOptions)
        .then((snapshot) => {
          requestId = snapshot.requestId;
          snapshotCwd = snapshot.cwd;
          latestEntries = snapshot.entries;
          if (!snapshot.entries.some((entry) => entry.status === "loading")) {
            finish(snapshot);
            return;
          }
          const pendingUpdate = pendingUpdates.get(snapshotCwd);
          if (pendingUpdate && !pendingUpdate.entries.some((entry) => entry.status === "loading")) {
            finish({ ...pendingUpdate, requestId });
          }
          return undefined;
        })
        .catch(fail);
    });
  } finally {
    await observation.release();
  }
}

function createGeneratedClientId(): string {
  const randomId =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : Math.random().toString(36).slice(2);
  return `alp-sdk-${randomId}`;
}
