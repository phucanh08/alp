import { type AgentLister, findSeatAgents } from "./discovery";
import { expandUserPath, isSupervisorWorkspace } from "./paths";
import { SEAT_LABEL, type Seat, seatOf } from "./seat";

export const LEAD_PROVIDER = "claude-lead";
export const SUPERVISOR_PROVIDER = "claude-supervisor";
/** Lead and Supervisor call Paseo tools and read the host without permission cards. */
export const SEAT_MODE = "bypassPermissions";
export const LEAD_TITLE = "Lead";
export const SUPERVISOR_TITLE = "Supervisor";
export const SUPERVISOR_WORKSPACE_TITLE = "SLP Supervisor";

export interface ModelLike {
  id: string;
  isDefault?: boolean;
  isSelectable?: boolean;
}

export interface WorkspaceLike {
  id: string;
  projectId?: string;
  projectRootPath: string;
  workspaceDirectory?: string;
  archivingAt?: string | null;
}

export interface SeatAgentCreate {
  config: { provider: string; modeId: string };
  title: string;
  labels: Record<string, string>;
}

/** The slice of the plugin `PaseoApi` the ensure operations use; narrow so tests can fake it. */
export interface EnsureApi {
  agents: AgentLister;
  workspaces: {
    list(options: { page: { limit: number; cursor?: string } }): Promise<{
      entries: WorkspaceLike[];
      pageInfo: { nextCursor: string | null };
    }>;
    create(options: { source: { kind: "directory"; path: string }; title: string }): Promise<{
      id: string;
    }>;
    ref(workspaceId: string): {
      agents: { create(options: SeatAgentCreate): Promise<{ id: string }> };
    };
  };
  providers: {
    listModels(provider: string): Promise<{ models?: ModelLike[]; error?: string | null }>;
  };
}

export interface LeadEnsureResult {
  agentId: string;
  created: boolean;
}

export interface SupervisorEnsureResult extends LeadEnsureResult {
  workspaceId: string;
}

/** Runs one task at a time per key so concurrent ensures see each other's result. */
class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const next = previous.then(task, task);
    const tail: Promise<void> = next.then(
      () => this.release(key, tail),
      () => this.release(key, tail),
    );
    this.tails.set(key, tail);
    return next;
  }

  private release(key: string, tail: Promise<void>): void {
    if (this.tails.get(key) === tail) this.tails.delete(key);
  }
}

const queue = new KeyedQueue();

export function pickDefaultModel(models: readonly ModelLike[] | undefined): string | null {
  const selectable = (models ?? []).filter((model) => model.isSelectable !== false);
  return (selectable.find((model) => model.isDefault) ?? selectable[0])?.id ?? null;
}

async function seatProvider(api: EnsureApi, provider: string): Promise<string> {
  const { models, error } = await api.providers.listModels(provider);
  const model = pickDefaultModel(models);
  if (!model) {
    throw new Error(`Provider ${provider} has no selectable model${error ? `: ${error}` : ""}`);
  }
  return `${provider}/${model}`;
}

function seatAgent(provider: string, seat: Seat, title: string): SeatAgentCreate {
  return { config: { provider, modeId: SEAT_MODE }, title, labels: { [SEAT_LABEL]: seat } };
}

function workspaceDirectory(workspace: WorkspaceLike): string {
  return expandUserPath(workspace.workspaceDirectory ?? workspace.projectRootPath);
}

async function listWorkspaces(api: EnsureApi): Promise<WorkspaceLike[]> {
  const all: WorkspaceLike[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await api.workspaces.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    all.push(...page.entries);
    if (!page.pageInfo.nextCursor) return all;
    cursor = page.pageInfo.nextCursor;
  }
}

/** `slp.lead.ensure`: the workspace has one live Lead; creates it when missing. */
export function ensureLead(
  api: EnsureApi,
  workspaceId: string,
  deps: { supervisorDirectory: string },
): Promise<LeadEnsureResult> {
  return queue.run(`lead:${workspaceId}`, async () => {
    const workspace = (await listWorkspaces(api)).find((entry) => entry.id === workspaceId);
    if (!workspace || workspace.archivingAt) {
      throw new Error(`Workspace ${workspaceId} is not an active workspace`);
    }
    if (isSupervisorWorkspace(workspaceDirectory(workspace), deps.supervisorDirectory)) {
      throw new Error("The SLP Supervisor system workspace has no Lead");
    }
    const existing = (await findSeatAgents(api.agents, "lead")).find(
      (agent) => agent.workspaceId === workspaceId,
    );
    if (existing) return { agentId: existing.id, created: false };
    const provider = await seatProvider(api, LEAD_PROVIDER);
    const agent = await api.workspaces
      .ref(workspaceId)
      .agents.create(seatAgent(provider, "lead", LEAD_TITLE));
    return { agentId: agent.id, created: true };
  });
}

/**
 * `slp.supervisor.ensure`: one Supervisor per host, in the `SLP Supervisor` workspace at
 * `$PASEO_HOME/supervisor`. A live Supervisor anywhere on the host is reused.
 */
export function ensureSupervisor(
  api: EnsureApi,
  deps: { supervisorDirectory: string; makeDirectory: (directory: string) => Promise<unknown> },
): Promise<SupervisorEnsureResult> {
  return queue.run("supervisor", async () => {
    const [live] = await findSeatAgents(api.agents, "supervisor");
    if (live) {
      if (!live.workspaceId) throw new Error(`Supervisor ${live.id} has no workspace`);
      return { workspaceId: live.workspaceId, agentId: live.id, created: false };
    }
    await deps.makeDirectory(deps.supervisorDirectory);
    const existing = (await listWorkspaces(api)).find(
      (workspace) =>
        !workspace.archivingAt &&
        isSupervisorWorkspace(workspaceDirectory(workspace), deps.supervisorDirectory),
    );
    const workspaceId =
      existing?.id ??
      (
        await api.workspaces.create({
          source: { kind: "directory", path: deps.supervisorDirectory },
          title: SUPERVISOR_WORKSPACE_TITLE,
        })
      ).id;
    const provider = await seatProvider(api, SUPERVISOR_PROVIDER);
    const agent = await api.workspaces
      .ref(workspaceId)
      .agents.create(seatAgent(provider, "supervisor", SUPERVISOR_TITLE));
    return { workspaceId, agentId: agent.id, created: true };
  });
}

/** Project of the workspace checked out at `cwd`, used to match a worktree request later. */
export async function projectOfCheckout(api: EnsureApi, cwd: string): Promise<string | null> {
  const directory = expandUserPath(cwd);
  const match = (await listWorkspaces(api)).find(
    (workspace) => !workspace.archivingAt && workspaceDirectory(workspace) === directory,
  );
  return match?.projectId ?? null;
}

/** The `workspace.create` request fields the origin tracker reads. */
export interface WorkspaceCreateLike {
  source:
    | { kind: "directory"; path: string }
    | { kind: "worktree"; projectId?: string; cwd?: string };
  agent?: { config: { provider: string } };
}

type PendingOrigin =
  | { kind: "directory"; path: string; at: number }
  | { kind: "worktree"; projectId: string | null; at: number };

/**
 * Tells client-created workspaces apart from the rest. `workspace.created` fires for every
 * workspace, including the worktrees a Lead creates for its Peers over MCP, but only app and CLI
 * requests pass `before("workspace.create")`. A directory request matches by path; a worktree
 * request matches by project (or the oldest one without a project), since its path is chosen later.
 */
export class ClientWorkspaceOrigins {
  private pending: PendingOrigin[] = [];

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 10 * 60_000,
  ) {}

  record(request: WorkspaceCreateLike): void {
    // A workspace created together with its own Lead needs no second one.
    if (request.agent && seatOf(request.agent.config.provider) === "lead") return;
    const at = this.now();
    this.pending.push(
      request.source.kind === "directory"
        ? { kind: "directory", path: expandUserPath(request.source.path), at }
        : { kind: "worktree", projectId: request.source.projectId ?? null, at },
    );
  }

  consume(workspace: { cwd: string; projectId: string }): boolean {
    const cutoff = this.now() - this.ttlMs;
    this.pending = this.pending.filter((origin) => origin.at >= cutoff);
    const cwd = expandUserPath(workspace.cwd);
    let index = this.pending.findIndex(
      (origin) => origin.kind === "directory" && origin.path === cwd,
    );
    if (index < 0) {
      index = this.pending.findIndex(
        (origin) =>
          origin.kind === "worktree" &&
          (origin.projectId === null || origin.projectId === workspace.projectId),
      );
    }
    if (index < 0) return false;
    this.pending.splice(index, 1);
    return true;
  }
}

/** `workspace.created`: a Lead for client-created workspaces, never for the Supervisor one. */
export async function handleWorkspaceCreated(
  api: EnsureApi,
  origins: ClientWorkspaceOrigins,
  workspace: { id: string; projectId: string; cwd: string },
  deps: { supervisorDirectory: string },
): Promise<LeadEnsureResult | null> {
  const fromClient = origins.consume(workspace);
  if (!fromClient || isSupervisorWorkspace(workspace.cwd, deps.supervisorDirectory)) return null;
  return ensureLead(api, workspace.id, deps);
}
