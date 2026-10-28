import { randomBytes } from 'node:crypto';
import { mkdir, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { deriveAgentStateBucket, getWorkspaceStateBucketPriority } from '@getpaseo/protocol/agent-state-bucket';
import { normalizeWorkspaceLabelName, workspaceLabelKey, type WorkspaceLabelDefinition } from '@getpaseo/protocol/workspace-labels';
import { firstMessage } from './prompt-content.js';
import type { AgentSnapshotPayload, SessionInboundMessage, SessionOutboundMessage } from '@getpaseo/protocol/messages';
import type { SessionSummary } from '@anhlp/alp-protocol/session';
import type { ClientContext, Handler } from './gateway.js';
import { checkoutCache, checkoutFacts, type CheckoutFacts } from './git.js';
import { createCreationReceipts, creationDigest, type CreationReceipts, type CreationAttempt } from './create-receipts.js';

/**
 * Paseo's projects and workspaces, kept by alpd (D31 step 6, ALPD §62). A project is a directory
 * the user opened; a workspace is a place in it where agents run, with the title, pin, labels and
 * archive the user gives it. The daemon domain service owns metadata and root placement; this
 * adapter prepares placement asynchronously and formats only committed snapshots. New roots use
 * their directory's oldest open workspace unless explicitly assigned. Generated ids are Paseo's
 * (`prj_`, `wks_` and 16 hex), retained in `<ALP home>/state/web-workspaces.json`.
 */

type Inbound<T extends SessionInboundMessage['type']> = Extract<SessionInboundMessage, { type: T }>;
type Outbound = SessionOutboundMessage;
type WorkspaceDescriptor = Extract<Outbound, { type: 'workspace_update' }>['payload'] extends infer P ? P extends { kind: 'upsert'; workspace: infer W } ? W : never : never;
type ProjectDescriptor = Extract<Outbound, { type: 'project.list.response' }>['payload']['projects'][number];
export type Placement = Extract<Outbound, { type: 'fetch_agents_response' }>['payload']['entries'][number]['project'];

type ProjectRecord = { id: string; root: string; customName?: string | null; addedAt: string; removedAt?: string | null };
type WorkspaceRecord = { id: string; projectId: string; directory: string; title?: string | null; pinnedAt?: string | null; labels: string[]; createdAt: string; archivedAt?: string | null; idempotencyKey?: string; worktree?: {kind: 'user'; source: string; branch: string; requestId?: string; ifRevision?: number} };
type Registry = {
  revision?: number; worktreeJournal?: Record<string,{intent:any}>;
  projects: ProjectRecord[];
  workspaces: WorkspaceRecord[];
  /** Root session id → workspace id. */
  sessions: Record<string, string>;
  labels: { generation: string; seq: number; catalog: WorkspaceLabelDefinition[] };
};

/** What the workspaces need of the agents (agents.ts). */
export type AgentsView = {
  roots(): SessionSummary[];
  snapshot(session: SessionSummary): AgentSnapshotPayload;
  archive(sessionId: string): Promise<void>;
  markUnread(sessionId: string): void;
  clearAttention(sessionIds: string[]): string[];
  validateFirst?(input: Omit<CreateAgentInput, 'workspaceId'>): void;
  create(input: CreateAgentInput): Promise<AgentSnapshotPayload>;
};
/** `images` and `attachments` are Paseo's (send_agent_message's); see prompt-content.ts for what ALP takes of them. */
export type CreateAgentInput = { config: { provider: string; cwd: string; model?: string | null; modeId?: string | null; title?: string | null }; workspaceId: string; initialPrompt?: string; clientMessageId?: string; images?: unknown[]; attachments?: unknown[]; client?: ClientContext; creationKey?: string; creationIntent?: unknown; attempt?: CreationAttempt };

const hex = () => randomBytes(8).toString('hex');
const now = () => new Date().toISOString();
const GIT_POLL_MS = 10_000;

class RequestError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

async function isDirectory(directory: string) {
  return (await stat(directory).catch(() => undefined))?.isDirectory() ?? false;
}

export function createWorkspaces({ rpc, broadcast, agents, inDevelopment, receipts = createCreationReceipts(), log = () => {} }: {
  receipts?: CreationReceipts;
  rpc(method: string, params: any): Promise<any>;
  broadcast(message: Outbound): void;
  agents: () => AgentsView;
  inDevelopment: () => Promise<string>;
  log?: (message: string) => void;
}) {
  let registry: Registry = { projects: [], workspaces: [], sessions: {}, labels: { generation: hex(), seq: 0, catalog: [] } };
  // Only registered live workspace roots have an existing daemon Git contract. Empty
  // projects and pre-registration validation retain the isolated legacy read for now.
  const registered = (directory: string) => registry.workspaces.filter(entry => entry.directory === directory && active(entry))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  const git = checkoutCache(10_000, async directory => {
    const entry = registered(directory);
    if (!entry) return checkoutFacts(directory).catch(() => ({ isGit: false }));
    // Permission, transport and read failures propagate; none are evidence of non-Git.
    // Only explicit unsupported-contract boundaries retain legacy owner metadata.
    let status;
    try { status = await rpc('workspace.git.status', { workspaceId: entry.id }); }
    catch (error: any) {
      // This facade uses the owner's private daemon connection. Older daemons have
      // no workspace.git method: retain only the previous optional metadata seam.
      // The checkout panels still report their own capability error, without Git.
      if (error?.code === -32601) return checkoutFacts(directory).catch(() => ({ isGit: false }));
      throw error;
    }
    if (status.state === 'not_repository') return { isGit: false };
    // A nested checkout is outside workspace.git's top-level-only contract. Its
    // legacy facts retain the actual ancestor root, never the requested directory.
    if (status.state === 'unsupported' && status.reason === 'not_repository_root') return checkoutFacts(directory).catch(() => ({ isGit: false }));
    if (status.state !== 'repository') throw new RequestError('Git metadata requires a supported repository root');
    return { isGit: true, repoRoot: directory, currentBranch: status.branch, remoteUrl: status.remoteUrl, isDirty: status.dirty };
  }, directory => `${registered(directory)?.id ?? 'project-only'}:${directory}`);
  /** What each client last heard, so only changes are sent. */
  const sentWorkspaces = new Map<string, string>();
  const sentProjects = new Map<string, string>();
  let syncQueued = false;
  let gitTimer: NodeJS.Timeout | undefined;
  let ownerTail: Promise<unknown> = Promise.resolve();
  // Only committed daemon snapshots are visible to descriptor/placement readers.
  function load() { return rpc('registry.owner', {}).then(({ registry: value }) => { registry = value; }); }
  function mutate(operation: string, args: any, requestId = hex()) {
    const run = ownerTail.then(async () => {
      const { registry: value, result } = await rpc('registry.owner', { operation, args, requestId });
      registry = value;
      return result;
    });
    ownerTail = run.catch(() => {});
    return run;
  }
  const project = (id: string) => registry.projects.find(entry => entry.id === id);
  const workspace = (id: string) => registry.workspaces.find(entry => entry.id === id);
  const active = (entry: WorkspaceRecord) => !entry.archivedAt && !project(entry.projectId)?.removedAt;

  /** Placement is prepared asynchronously before any root snapshot is published. */
  async function prepare(sessions: SessionSummary[]) {
    if (sessions.length) await mutate('placement.prepare', { sessions: sessions.map(({ id, projectRoot, archived, status, updatedAt }) => ({ id, projectRoot, archived, status, updatedAt })) });
    else await load();
  }
  function workspaceIdFor(session: SessionSummary) {
    const id = registry.sessions[session.id];
    if (!id || !workspace(id)) throw new Error(`Placement not prepared for ${session.id}`);
    return id;
  }
  async function assign(sessionId: string, workspaceId: string) { await mutate('placement.assign', { sessionId, workspaceId }); }

  function checkoutOf(directory: string): Placement['checkout'] {
    const facts = git.peek(directory);
    return facts?.isGit
      ? { cwd: directory, worktreeRoot: facts.repoRoot, isGit: true, currentBranch: facts.currentBranch, remoteUrl: facts.remoteUrl, isPaseoOwnedWorktree: false, mainRepoRoot: null }
      : { cwd: directory, worktreeRoot: null, isGit: false, currentBranch: null, remoteUrl: null, isPaseoOwnedWorktree: false, mainRepoRoot: null };
  }

  const projectName = (entry: ProjectRecord) => entry.customName || path.basename(entry.root) || entry.root;
  const projectKind = (entry: ProjectRecord) => git.peek(entry.root)?.isGit ? 'git' as const : 'non_git' as const;

  /** An agent's place, keyed by its project's id as Paseo's daemon does. */
  function placement(session: SessionSummary): Placement {
    const entry = workspace(workspaceIdFor(session))!;
    const owner = project(entry.projectId)!;
    return { projectKey: owner.id, projectName: projectName(owner), workspaceName: nameOf(entry), checkout: checkoutOf(entry.directory) };
  }

  function projectDescriptor(entry: ProjectRecord): ProjectDescriptor {
    return { projectId: entry.id, projectKey: entry.id, projectDisplayName: projectName(entry), projectCustomName: entry.customName ?? null, projectRootPath: entry.root, projectKind: projectKind(entry) };
  }

  function nameOf(entry: WorkspaceRecord) {
    const facts = git.peek(entry.directory);
    return entry.title || (facts?.isGit ? facts.currentBranch : null) || path.basename(entry.directory) || entry.directory;
  }

  function rootsIn(id: string) {
    return agents().roots().filter(session => registry.sessions[session.id] === id && !session.archived);
  }

  function descriptor(entry: WorkspaceRecord): WorkspaceDescriptor {
    const owner = project(entry.projectId)!;
    const facts: CheckoutFacts | undefined = git.peek(entry.directory);
    const snapshots = rootsIn(entry.id).map(session => agents().snapshot(session));
    let status: WorkspaceDescriptor['status'] = 'done';
    for (const agent of snapshots) {
      const bucket = deriveAgentStateBucket({ status: agent.status, requiresAttention: agent.requiresAttention, attentionReason: agent.attentionReason, pendingPermissionCount: agent.pendingPermissions.length });
      if (getWorkspaceStateBucketPriority(bucket) < getWorkspaceStateBucketPriority(status)) status = bucket;
    }
    const activityAt = snapshots.map(agent => agent.updatedAt).sort().at(-1) ?? null;
    return {
      id: entry.id,
      projectId: owner.id,
      projectDisplayName: projectName(owner),
      projectCustomName: owner.customName ?? null,
      projectRootPath: owner.root,
      workspaceDirectory: entry.directory,
      projectKind: projectKind(owner),
      workspaceKind: entry.worktree ? 'worktree' : facts?.isGit ? 'local_checkout' : 'directory',
      name: nameOf(entry),
      title: entry.title ?? null,
      pinnedAt: entry.pinnedAt ?? null,
      labels: entry.labels,
      archivingAt: null,
      status,
      statusEnteredAt: null,
      activityAt: activityAt ?? entry.createdAt,
      scripts: [],
      gitRuntime: facts?.isGit ? { currentBranch: facts.currentBranch, remoteUrl: facts.remoteUrl, isPaseoOwnedWorktree: false, isDirty: facts.isDirty, aheadBehind: null, aheadOfOrigin: null, behindOfOrigin: null } : null,
      githubRuntime: null,
      project: { projectKey: owner.id, projectName: projectName(owner), workspaceName: nameOf(entry), checkout: checkoutOf(entry.directory) },
    };
  }

  /** Tells every client what changed in the workspaces and projects since it last heard. */
  function sync() {
    syncQueued = false;
    const open = registry.workspaces.filter(active);
    const openIds = new Set(open.map(entry => entry.id));
    for (const entry of open) {
      const value = descriptor(entry);
      const text = JSON.stringify(value);
      if (sentWorkspaces.get(entry.id) === text) continue;
      sentWorkspaces.set(entry.id, text);
      broadcast({ type: 'workspace_update', payload: { kind: 'upsert', workspace: value } });
    }
    for (const id of [...sentWorkspaces.keys()]) {
      if (openIds.has(id)) continue;
      sentWorkspaces.delete(id);
      const owner = project(workspace(id)?.projectId ?? '');
      const empty = owner && !owner.removedAt && !open.some(entry => entry.projectId === owner.id);
      broadcast({ type: 'workspace_update', payload: { kind: 'remove', id, ...(empty ? { emptyProject: projectDescriptor(owner) } : {}), ...(owner?.removedAt ? { removedProjectId: owner.id } : {}) } });
    }
    const projects = registry.projects.filter(entry => !entry.removedAt);
    const projectIds = new Set(projects.map(entry => entry.id));
    for (const entry of projects) {
      const value = projectDescriptor(entry);
      const text = JSON.stringify(value);
      if (sentProjects.get(entry.id) === text) continue;
      sentProjects.set(entry.id, text);
      broadcast({ type: 'project.update', payload: { kind: 'upsert', project: value } });
    }
    for (const id of [...sentProjects.keys()]) {
      if (projectIds.has(id)) continue;
      sentProjects.delete(id);
      broadcast({ type: 'project.update', payload: { kind: 'remove', projectId: id } });
    }
  }

  function queueSync() {
    if (syncQueued) return;
    syncQueued = true;
    setImmediate(sync);
  }

  /** Reads the checkouts again and tells clients when a branch or dirtiness changed. */
  async function readCheckouts(force = false) {
    const directories = new Set<string>();
    for (const entry of registry.workspaces.filter(active)) { directories.add(entry.directory); directories.add(project(entry.projectId)!.root); }
    for (const entry of registry.projects.filter(candidate => !candidate.removedAt)) directories.add(entry.root);
    await Promise.all([...directories].map(directory => git.read(directory, force)));
    queueSync();
  }

  /** Every open workspace as the app lists them, with the projects that have none. */
  function listing(message: Inbound<'fetch_workspaces_request'>) {
    const query = message.filter?.query?.trim().toLowerCase();
    let rows = registry.workspaces.filter(active)
      .filter(entry => !message.filter?.projectId || entry.projectId === message.filter.projectId)
      .map(descriptor)
      .filter(entry => !query || [entry.name, entry.projectDisplayName, entry.workspaceDirectory ?? ''].some(text => text.toLowerCase().includes(query)));
    const sort = message.sort?.length ? message.sort : [{ key: 'activity_at' as const, direction: 'desc' as const }];
    rows = rows.sort((a, b) => {
      for (const { key, direction } of sort) {
        const order = key === 'status_priority' ? getWorkspaceStateBucketPriority(a.status) - getWorkspaceStateBucketPriority(b.status)
          : key === 'name' ? a.name.localeCompare(b.name)
          : key === 'project_id' ? a.projectId.localeCompare(b.projectId)
          : (a.activityAt ?? '').localeCompare(b.activityAt ?? '');
        if (order) return direction === 'asc' ? order : -order;
      }
      return 0;
    });
    const offset = Number(message.page?.cursor ?? 0) || 0;
    const limit = message.page?.limit ?? rows.length;
    const more = offset + limit < rows.length;
    const withWorkspaces = new Set(registry.workspaces.filter(active).map(entry => entry.projectId));
    return {
      entries: rows.slice(offset, offset + limit),
      emptyProjects: offset ? [] : registry.projects.filter(entry => !entry.removedAt && !withWorkspaces.has(entry.id)).map(projectDescriptor),
      pageInfo: { nextCursor: more ? String(offset + limit) : null, prevCursor: offset ? String(Math.max(0, offset - limit)) : null, hasMore: more },
    };
  }

  async function addProject(cwd: string, requestId?: string) {
    const directory = path.resolve(cwd);
    if (!path.isAbsolute(cwd) || !await isDirectory(directory)) throw new RequestError(`${cwd} is not a directory`, 'directory_not_found');
    await git.read(directory, true);
    // Owner add preserves the legacy empty-project behavior; remote register makes its default workspace.
    const result = await mutate('project.add', { directory }, requestId);
    queueSync();
    return project(result.project.id)!;
  }
  async function archiveWorkspace(entry: WorkspaceRecord, requestId?: string) {
    for (const session of rootsIn(entry.id)) await agents().archive(session.id);
    await mutate('workspace.update', { workspaceId: entry.id, archived: true }, requestId);
    queueSync();
    return workspace(entry.id)!.archivedAt ?? null;
  }
  function labelBroadcast(payload: any) {
    broadcast({ type: 'workspace.label.update', payload: { ...payload, generation: registry.labels.generation, seq: registry.labels.seq } } as Outbound);
  }
  const catalogEntry = (name: string) => registry.labels.catalog.find(label => workspaceLabelKey(label.name) === workspaceLabelKey(name));

  function known(workspaceId: string) {
    const entry = workspace(workspaceId);
    if (!entry || !active(entry)) throw new RequestError(`No workspace ${workspaceId}`, 'workspace_not_found');
    return entry;
  }

  const message = (error: unknown) => error instanceof Error ? error.message : String(error);
  const code = (error: unknown) => error instanceof RequestError ? error.code : undefined;

  const handlers: Record<string, Handler> = {
    async fetch_workspaces_request(request: Inbound<'fetch_workspaces_request'>) {
      await load();
      await readCheckouts();
      sync();
      return { type: 'fetch_workspaces_response', payload: { requestId: request.requestId, subscriptionId: request.subscribe?.subscriptionId ?? null, ...listing(request) } } satisfies Outbound;
    },

    async 'project.list.request'(request: Inbound<'project.list.request'>) {
      await load();
      return { type: 'project.list.response', payload: { requestId: request.requestId, projects: registry.projects.filter(entry => !entry.removedAt).map(projectDescriptor) } } satisfies Outbound;
    },

    async 'project.add.request'(request: Inbound<'project.add.request'>) {
      await load();
      try {
        const entry = await addProject(request.cwd, request.requestId);
        return { type: 'project.add.response', payload: { requestId: request.requestId, project: projectDescriptor(entry), error: null } } satisfies Outbound;
      } catch (error) {
        return { type: 'project.add.response', payload: { requestId: request.requestId, project: null, error: message(error), errorCode: code(error) === 'directory_not_found' ? 'directory_not_found' : null } } satisfies Outbound;
      }
    },

    async 'project.create_directory.request'(request: Inbound<'project.create_directory.request'>) {
      await load();
      const fail = (error: unknown) => ({ type: 'project.create_directory.response', payload: { requestId: request.requestId, directoryPath: null, project: null, error: message(error), errorCode: code(error) ?? null } }) satisfies Outbound;
      const name = request.name.trim();
      if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) return fail(new RequestError('The folder name must be one plain name', 'invalid_name'));
      if (!path.isAbsolute(request.parentPath) || !await isDirectory(request.parentPath)) return fail(new RequestError(`${request.parentPath} is not a directory`, 'directory_not_found'));
      const directory = path.join(path.resolve(request.parentPath), name);
      try {
        await mkdir(directory);
      } catch (error: any) {
        return fail(new RequestError(error?.code === 'EEXIST' ? `${directory} already exists` : message(error), error?.code === 'EEXIST' ? 'directory_exists' : undefined));
      }
      const entry = await addProject(directory);
      return { type: 'project.create_directory.response', payload: { requestId: request.requestId, directoryPath: directory, project: projectDescriptor(entry), error: null, errorCode: null } } satisfies Outbound;
    },

    async 'project.rename.request'(request: Inbound<'project.rename.request'>) {
      await load();
      const entry = project(request.projectId);
      if (!entry || entry.removedAt) return { type: 'project.rename.response', payload: { requestId: request.requestId, projectId: request.projectId, accepted: false, customName: null, error: `No project ${request.projectId}` } } satisfies Outbound;
      await mutate('project.rename', { projectId: entry.id, customName: request.customName }, request.requestId);
      queueSync();
      return { type: 'project.rename.response', payload: { requestId: request.requestId, projectId: entry.id, accepted: true, customName: project(entry.id)!.customName ?? null, error: null } } satisfies Outbound;
    },

    async 'project.remove.request'(request: Inbound<'project.remove.request'>) {
      await load();
      const entry = project(request.projectId);
      if (!entry || entry.removedAt) return { type: 'project.remove.response', payload: { requestId: request.requestId, projectId: request.projectId, accepted: false, removedWorkspaceIds: [], error: `No project ${request.projectId}` } } satisfies Outbound;
      const removed = registry.workspaces.filter(candidate => candidate.projectId === entry.id && active(candidate));
      for (const candidate of removed) await archiveWorkspace(candidate);
      await mutate('project.remove', { projectId: entry.id }, request.requestId);
      // A project without workspaces leaves by its own id, as Paseo's daemon sends it.
      if (!removed.length) broadcast({ type: 'workspace_update', payload: { kind: 'remove', id: entry.id, removedProjectId: entry.id } });
      sync();
      return { type: 'project.remove.response', payload: { requestId: request.requestId, projectId: entry.id, accepted: true, removedWorkspaceIds: removed.map(candidate => candidate.id), error: null } } satisfies Outbound;
    },

    async open_project_request(request: Inbound<'open_project_request'>) {
      await load();
      try {
        const owner = await addProject(request.cwd, request.requestId);
        const directory = path.resolve(request.cwd);
        let entry = registry.workspaces.filter(candidate => candidate.directory === directory && active(candidate)).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
        if (!entry) { const made = await mutate('workspace.create', { directory, projectId: owner.id }, request.requestId + ':workspace'); entry = workspace(made.workspace.id)!; }
        await git.read(directory);
        sync();
        return { type: 'open_project_response', payload: { requestId: request.requestId, workspace: descriptor(entry), error: null } } satisfies Outbound;
      } catch (error) {
        return { type: 'open_project_response', payload: { requestId: request.requestId, workspace: null, error: message(error), errorCode: code(error) === 'directory_not_found' ? 'directory_not_found' : null } } satisfies Outbound;
      }
    },

    async create_paseo_worktree_request(request: Inbound<'create_paseo_worktree_request'>, client: ClientContext) {
      const reply = (workspace: WorkspaceDescriptor | null, error: string | null, errorCode?: string): Outbound => ({ type: 'create_paseo_worktree_response', payload: { requestId: request.requestId, workspace, error, ...(errorCode ? { errorCode } : {}), setupTerminalId: null } });
      // Upstream FirstAgentContext drives naming/setup, not an agent prompt. This facade does not
      // run that automation, so explicitly refuse its input rather than silently discard context.
      const context = request.firstAgentContext;
      const hasAttachments = (value: unknown) => value !== undefined && (!Array.isArray(value) || value.length > 0);
      if ((context !== undefined && (!context || typeof context !== 'object' || Array.isArray(context) || (context.prompt !== undefined && context.prompt !== '') || hasAttachments(context.attachments))) || (request.nameContext !== undefined && request.nameContext !== '') || hasAttachments(request.attachments)) return reply(null, 'This ALP host cannot use first-agent context for worktree naming or setup; nothing was created');
      try {
      const result = await handlers['workspace.create.request']({ type: 'workspace.create.request', requestId: request.requestId, source: { kind: 'worktree', cwd: request.cwd, projectId: request.projectId, worktreeSlug: request.worktreeSlug, refName: request.refName, action: request.action, checkoutSource: request.checkoutSource, githubPrNumber: request.githubPrNumber } }, client) as Extract<Outbound, { type: 'workspace.create.response' }>;
      return reply(result.payload.workspace, result.payload.error, result.payload.errorCode);
      } catch (error) { return reply(null, message(error), code(error)); }
    },

    async 'workspace.create.request'(request: Inbound<'workspace.create.request'>, client: ClientContext) {
      await load();
      const reply = (fields: Partial<Extract<Outbound, { type: 'workspace.create.response' }>['payload']>): Outbound =>
        ({ type: 'workspace.create.response', payload: { requestId: request.requestId, workspace: null, setupTerminalId: null, error: null, ...fields } });
      if (request.source.kind === 'worktree') {
        try {
          const source = request.source;
          if (source.action === 'checkout' || source.refName || source.baseBranch || source.branchName || source.checkoutSource || source.githubPrNumber || source.worktreeSlug || request.agent) throw new RequestError('This host creates generated worktrees from committed HEAD only; custom refs, setup hooks and automatic agents are unavailable.');
          const requestId = request.idempotencyKey ?? request.requestId;
          const directory = source.cwd ?? (source.projectId ? project(source.projectId)?.root : undefined);
          if (!directory || request.workspaceId) throw new RequestError('An existing source is required; workspace identities are generated by the host.');
          const existing = registry.workspaces.find(w => w.worktree?.requestId === requestId);
          if (existing) { if (existing.worktree?.source !== await realpath(directory)) throw new RequestError('Idempotency key names another source.'); return reply({workspace:descriptor(existing)}); }
          const origin = registry.workspaces.find(w => w.directory === directory && active(w));
          if (!origin) throw new RequestError('Register the source directory first.');
          const options = await rpc('workspace.worktree.options',{workspaceId:origin.id});
          if (options.mappingIds.length !== 1) throw new RequestError('The host must approve exactly one destination mapping for this source.');
          const pending = Object.values(registry.worktreeJournal ?? {}).find(j => j.intent.method === 'create' && j.intent.requestId === requestId)?.intent;
          const made = await rpc('workspace.worktree.create',{workspaceId:origin.id,mappingId:options.mappingIds[0],requestId,ifRevision:pending?.ifRevision ?? registry.revision});
          await load();const entry=workspace(made.workspace.id)!;await git.read(entry.directory);sync();return reply({workspace:descriptor(entry)});
        } catch(error) { return reply({error:message(error)}); }
      }
      try {
        // A first agent whose message carries what ALP cannot send (attachments, malformed images) is
        // refused before the workspace is made; agents().create builds the same message again.
        if (request.agent) {
          firstMessage(request.agent.initialPrompt, request.agent.images, request.agent.attachments);
          agents().validateFirst?.({ ...request.agent, client });
        }
        client?.assertActive?.();
        const { requestId: _requestId, idempotencyKey, ...intent } = request;
        const identity = idempotencyKey ?? request.requestId;
        const source = request.source;
        const result = await receipts.run('workspace', identity, intent, !!request.agent?.attachments?.length, async (state, checkpoint) => {
          if (!state.phase) {
            // Legacy metadata cannot prove which initial-agent intent ran. Never infer absence.
            if (idempotencyKey && registry.workspaces.some(entry => entry.idempotencyKey === idempotencyKey)) throw new RequestError('Workspace creation has no matching creation receipt; inspect its initial agent before retrying');
            await checkpoint({ phase: 'workspace_ready' });
          }
          if (state.phase === 'workspace_pending') throw new RequestError('Workspace creation outcome is unknown; inspect it before retrying');
          if (!['workspace_ready', 'workspace_created', 'create_ready', 'create_pending', 'native_created', 'native_ready', 'rename_pending', 'prompt_pending', 'failed', 'done'].includes(state.phase!)) throw new RequestError('Invalid workspace creation receipt');
          const directory = path.resolve(source.path);
          if (state.phase === 'workspace_ready') {
            if (!path.isAbsolute(source.path) || !await isDirectory(directory)) throw new RequestError(`${source.path} is not a directory`, 'directory_not_found');
            await git.read(directory); client?.assertActive?.();
            await checkpoint({ phase: 'workspace_pending' });
            try { client?.assertActive?.(); }
            catch (error) { await checkpoint({ phase: 'workspace_ready' }); throw error; }
            try {
              const operationId = creationDigest(['workspace', identity]);
              const owner = source.projectId ? project(source.projectId) : await addProject(directory, `create-project:${operationId}`);
              if (!owner || owner.removedAt) throw new RequestError(`No project ${source.projectId}`);
              const made = await mutate('workspace.create', { directory, projectId: owner.id, workspaceId: request.workspaceId, title: request.title, idempotencyKey }, `create-workspace:${operationId}`);
              await checkpoint({ phase: 'workspace_created', workspaceId: made.workspace.id });
            } catch (error: any) {
              if (error?.code === -32602) await checkpoint({ phase: 'workspace_ready' });
              throw error;
            }
          }
          if (!state.workspaceId) throw new RequestError('Invalid reserved workspace identity');
          let agent: AgentSnapshotPayload | undefined;
          if (request.agent && state.phase !== 'done') {
            const { config, initialPrompt, clientMessageId, images, attachments } = request.agent;
            agent = await agents().create({ client, attempt: { state, checkpoint }, config: { ...config, cwd: directory }, workspaceId: state.workspaceId!, ...(initialPrompt ? { initialPrompt } : {}), ...(clientMessageId ? { clientMessageId } : {}), ...(images ? { images } : {}), ...(attachments ? { attachments } : {}) });
          }
          if (state.phase !== 'done') await checkpoint({ phase: 'done', ...(agent ? { agentId: agent.id } : {}) });
          return { workspaceId: state.workspaceId!, agentId: state.agentId };
        });
        await load();
        const entry = workspace(result.workspaceId);
        if (!entry || !active(entry)) throw new RequestError('The retained creation result is no longer available; nothing was recreated');
        const session = result.agentId && agents().roots().find(root => root.id === result.agentId);
        if (result.agentId && !session) throw new RequestError('The retained initial agent is no longer available; nothing was recreated');
        sync();
        return reply({ workspace: descriptor(entry), ...(session ? { agent: agents().snapshot(session) } : {}) });
      } catch (error) {
        return reply({ error: message(error), ...(code(error) ? { errorCode: code(error) } : {}) });
      }
    },

    async 'workspace.title.set.request'(request: Inbound<'workspace.title.set.request'>) {
      await load();
      try {
        const entry = known(request.workspaceId);
        await mutate('workspace.update', { workspaceId: entry.id, title: request.title ?? null }, request.requestId);
        sync();
        return { type: 'workspace.title.set.response', payload: { requestId: request.requestId, workspaceId: entry.id, accepted: true, title: workspace(entry.id)!.title ?? null, error: null } } satisfies Outbound;
      } catch (error) {
        return { type: 'workspace.title.set.response', payload: { requestId: request.requestId, workspaceId: request.workspaceId, accepted: false, title: null, error: message(error) } } satisfies Outbound;
      }
    },

    async 'workspace.pin.set.request'(request: Inbound<'workspace.pin.set.request'>) {
      await load();
      try {
        const entry = known(request.workspaceId);
        await mutate('workspace.update', { workspaceId: entry.id, pinned: request.pinned }, request.requestId);
        sync();
        return { type: 'workspace.pin.set.response', payload: { requestId: request.requestId, workspaceId: entry.id, accepted: true, pinnedAt: workspace(entry.id)!.pinnedAt ?? null, error: null } } satisfies Outbound;
      } catch (error) {
        return { type: 'workspace.pin.set.response', payload: { requestId: request.requestId, workspaceId: request.workspaceId, accepted: false, pinnedAt: null, error: message(error) } } satisfies Outbound;
      }
    },

    async archive_workspace_request(request: Inbound<'archive_workspace_request'>) {
      await load();
      try {
        const archivedAt = await archiveWorkspace(known(request.workspaceId), request.requestId);
        return { type: 'archive_workspace_response', payload: { requestId: request.requestId, workspaceId: request.workspaceId, archivedAt, error: null } } satisfies Outbound;
      } catch (error) {
        return { type: 'archive_workspace_response', payload: { requestId: request.requestId, workspaceId: request.workspaceId, archivedAt: null, error: message(error) } } satisfies Outbound;
      }
    },

    // Paseo 0.11.1–0.12.x: only scope=worktree requests disk removal. The legacy
    // deleteWorktreeFromDisk flag is ignored upstream; workspace scope is archive-only.
    async paseo_worktree_archive_request(request: Inbound<'paseo_worktree_archive_request'>) {
      const reply = (error: { code: 'NOT_ALLOWED' | 'UNKNOWN'; message: string } | null, removedAgents: string[] = []): Outbound =>
        ({ type: 'paseo_worktree_archive_response', payload: { requestId: request.requestId, success: !error, removedAgents, error } });
      try {
        await load();
        const canonical = async (value: string) => {
          if (!path.isAbsolute(value)) throw new RequestError('Worktree target must be an absolute path');
          // A committed removal can leave a record whose checkout is already absent.
          return realpath(value).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return path.resolve(value); throw error; });
        };
        const target = request.worktreePath ? await canonical(request.worktreePath) : undefined;
        const source = request.repoRoot ? await canonical(request.repoRoot) : undefined;
        let candidates = request.workspaceId ? registry.workspaces.filter(entry => entry.id === request.workspaceId)
          : target ? registry.workspaces.filter(entry => entry.directory === target)
          : source && request.branchName ? registry.workspaces.filter(entry => entry.worktree?.source === source && entry.worktree.branch === request.branchName) : [];
        if (!request.workspaceId && candidates.some(entry => entry.worktree)) candidates = candidates.filter(entry => entry.worktree);
        if (candidates.length !== 1) throw new RequestError('An unambiguous registered workspace target is required');
        const entry = candidates[0];
        if ((target && entry.directory !== target) || (source && entry.worktree?.source !== source) || (request.branchName && entry.worktree?.branch !== request.branchName))
          throw new RequestError('Worktree target does not match the workspace');
        if (request.scope !== 'worktree') {
          const ids = rootsIn(entry.id).map(session => session.id);
          await archiveWorkspace(known(entry.id), request.requestId);
          return reply(null, ids);
        }
        // No archive/session mutation before alpd's owner, mapping, dirty, lease and
        // retained-history guards. It alone owns native deletion and the tombstone.
        if (!entry.worktree) throw new RequestError('Only managed user worktrees can be removed');
        if (registry.workspaces.some(other => other.id !== entry.id && other.directory === entry.directory && active(other)))
          throw new RequestError('Other workspaces still reference this checkout');
        await rpc('workspace.worktree.remove', { workspaceId: entry.id, requestId: request.requestId, ifRevision: registry.revision });
        await load();
        sync();
        return reply(null);
      } catch (error: any) {
        if (error?.code === -32601) return reply({ code: 'UNKNOWN', message: 'This ALP daemon cannot remove managed worktrees; upgrade and restart it' });
        return reply({ code: error instanceof RequestError || error?.code === 1003 || error?.code === 1004 ? 'NOT_ALLOWED' : 'UNKNOWN', message: message(error) });
      }
    },

    /** Marks the newest finished root unread again, as Paseo's daemon does. */
    async 'workspace.mark_unread.request'(request: Inbound<'workspace.mark_unread.request'>) {
      await load();
      try {
        const entry = known(request.workspaceId);
        const candidate = rootsIn(entry.id).map(session => ({ session, agent: agents().snapshot(session) }))
          .filter(({ agent }) => agent.status !== 'running' && !agent.requiresAttention && !agent.pendingPermissions.length)
          .sort((a, b) => b.agent.updatedAt.localeCompare(a.agent.updatedAt))[0];
        if (candidate) agents().markUnread(candidate.session.id);
        sync();
        return { type: 'workspace.mark_unread.response', payload: { requestId: request.requestId, workspaceId: entry.id, markedAgentId: candidate?.session.id ?? null, success: !!candidate, error: candidate ? null : 'Nothing to mark unread' } } satisfies Outbound;
      } catch (error) {
        return { type: 'workspace.mark_unread.response', payload: { requestId: request.requestId, workspaceId: request.workspaceId, markedAgentId: null, success: false, error: message(error) } } satisfies Outbound;
      }
    },

    async 'workspace.clear_attention.request'(request: Inbound<'workspace.clear_attention.request'>) {
      await load();
      const ids = Array.isArray(request.workspaceId) ? request.workspaceId : [request.workspaceId];
      const results = ids.map(workspaceId => {
        try {
          const entry = known(workspaceId);
          return { workspaceId, clearedAgentIds: agents().clearAttention(rootsIn(entry.id).map(session => session.id)), success: true, error: null };
        } catch (error) {
          return { workspaceId, clearedAgentIds: [], success: false, error: message(error) };
        }
      });
      sync();
      const failed = results.find(result => !result.success);
      return { type: 'workspace.clear_attention.response', payload: { requestId: request.requestId, workspaceId: request.workspaceId, clearedAgentIds: results.flatMap(result => result.clearedAgentIds), results, success: !failed, error: failed?.error ?? null } } satisfies Outbound;
    },

    async 'workspace.label.list.request'(request: Inbound<'workspace.label.list.request'>) {
      await load();
      return {
        type: 'workspace.label.list.response',
        payload: {
          requestId: request.requestId,
          ...(request.subscribe?.subscriptionId ? { subscriptionId: request.subscribe.subscriptionId } : {}),
          labels: registry.labels.catalog,
          sync: { mode: 'snapshot', generation: registry.labels.generation, headSeq: registry.labels.seq, removals: [] },
        },
      } satisfies Outbound;
    },

    async 'workspace.label.assignment.set.request'(request: Inbound<'workspace.label.assignment.set.request'>) {
      await load(); const seq = registry.labels.seq;
      await mutate('label.assign', { workspaceId: request.workspaceId, label: request.label, assigned: request.assigned }, request.requestId);
      const label = catalogEntry(normalizeWorkspaceLabelName(request.label.name)) ?? request.label;
      if (registry.labels.seq !== seq) labelBroadcast({ kind: 'upsert', label });
      sync();
      return { type: 'workspace.label.assignment.set.response', payload: { requestId: request.requestId, label, workspaceLabels: known(request.workspaceId).labels } } satisfies Outbound;
    },
    async 'workspace.label.update.request'(request: Inbound<'workspace.label.update.request'>) {
      await load(); const previousName = catalogEntry(request.name)?.name;
      const affectedWorkspaceCount = registry.workspaces.filter(w => w.labels.some(n => workspaceLabelKey(n) === workspaceLabelKey(request.name))).length;
      await mutate('label.update', { name: request.name, newName: request.newName, color: request.color }, request.requestId);
      const label = catalogEntry(request.newName ?? request.name)!;
      labelBroadcast({ kind: 'upsert', label, ...(previousName !== label.name ? { previousName } : {}) }); sync();
      return { type: 'workspace.label.update.response', payload: { requestId: request.requestId, label, affectedWorkspaceCount } } satisfies Outbound;
    },
    async 'workspace.label.delete.inspect.request'(request: Inbound<'workspace.label.delete.inspect.request'>) {
      await load();
      const key = workspaceLabelKey(request.name);
      return { type: 'workspace.label.delete.inspect.response', payload: { requestId: request.requestId, affectedWorkspaceCount: registry.workspaces.filter(entry => active(entry) && entry.labels.some(existing => workspaceLabelKey(existing) === key)).length } } satisfies Outbound;
    },

    async 'workspace.label.delete.request'(request: Inbound<'workspace.label.delete.request'>) {
      await load();
      const label = catalogEntry(request.name);
      if (!label) throw new RequestError(`No label ${request.name}`, 'label_not_found');
      const affected = registry.workspaces.filter(w => w.labels.some(n => workspaceLabelKey(n) === workspaceLabelKey(request.name))).length;
      await mutate('label.delete', { name: request.name }, request.requestId);
      labelBroadcast({ kind: 'remove', name: label.name }); sync();
      return { type: 'workspace.label.delete.response', payload: { requestId: request.requestId, affectedWorkspaceCount: affected } } satisfies Outbound;
    },
  };

  return {
    handlers,
    async projectDirectories() {
      await load();
      return [...new Set([
        ...registry.projects.filter(entry => !entry.removedAt).map(entry => entry.root),
        ...registry.workspaces.filter(active).map(entry => entry.directory),
      ])];
    },
    features: {
      workspaceMultiplicity: true, projectList: true, projectAdd: true, stableProjectIdentity: true, projectRemove: true, projectCreateDirectory: true,
      workspacePinning: true, workspaceMarkUnread: true, workspaceLabels: true,
    },
    load,
    prepare,
    workspaceIdFor,
    placement,
    assign,
    /** Something about the agents changed: workspaces' status and activity follow. */
    changed: queueSync,
    start() {
      gitTimer ??= setInterval(() => void readCheckouts(true).catch(error => log(`checkouts not read: ${error?.message ?? error}`)), GIT_POLL_MS);
      gitTimer.unref();
      return load().then(() => readCheckouts());
    },
    close() {
      if (gitTimer) clearInterval(gitTimer);
      return ownerTail;
    },
  };
}
