/**
 * The workspace methods of alpd: the registry (registry.*, project.*, workspace.list/get/update),
 * worktrees (workspace.worktree.*), git reads (workspace.git.*), the files of a project
 * (workspace.files.*) and the host's directories (host.directories.search). alpd spreads them into
 * its handler table (server.ts).
 */
import { realpath as fsRealpath } from 'node:fs/promises';
import path from 'node:path';
import { ERROR, RPC_ERROR } from '@anhlp/alp-protocol';
import type { createLogger } from '@anhlp/alp-core/log';
import { RpcError } from '../../rpc/rpc-error.ts';
import { agentRefused } from '../../rpc/helpers.ts';
import type { Connection } from '../../rpc/connection.ts';
import { RegistryError, type createRegistry } from '../registry.ts';
import type { createWorkspaceWorktrees } from '../worktrees.ts';
import type { createGitReader } from '../git.ts';
import { type createFindPages, FileAccessError, FilesError, listWorkspaceDirectory, previewWorkspaceFile, readWorkspaceFile, searchHostDirectories, searchWorkspaceFiles } from '../files.ts';

// any: params arrive as JSON; each handler checks the fields it reads, as it did inline in server.ts.
type WorkspaceHandler = (connection: Connection, params: any) => Promise<unknown> | unknown;
type WorkspaceMethod = 'workspace.files.search' | 'workspace.files.list' | 'workspace.files.read' | 'workspace.files.find' | 'workspace.files.preview' | 'host.directories.search'
  | 'registry.owner' | 'registry.worktree' | 'workspace.worktree.options' | 'workspace.worktree.create' | 'workspace.worktree.remove'
  | 'workspace.git.status' | 'workspace.git.diff' | 'workspace.git.facts' | 'project.list' | 'workspace.list' | 'workspace.get'
  | 'project.register' | 'project.remove' | 'workspace.update';
type Label = { name: string; color: string };

/**
 * The handlers over this daemon's registry (none without a home), its worktrees, git readers and
 * find pages. `labelCatalog` reads the catalog alpd keeps now (server.ts reassigns it), and
 * `registryCall` is the wrapper session.create shares.
 */
export function createWorkspaceHandlers({ registry, worktrees, workspaceDescriptor, registryCall, gitReader, gitFacts, findPages, keepCatalog, labelCatalog, followLabel, log }: {
  registry: ReturnType<typeof createRegistry> | undefined;
  worktrees: ReturnType<typeof createWorkspaceWorktrees> | undefined;
  // any: a registry workspace row, described as the registry answers it.
  workspaceDescriptor: (w: any) => Promise<any>;
  // any: whatever the registry call answers.
  registryCall: (run: () => Promise<any>) => Promise<any>;
  gitReader: ReturnType<typeof createGitReader> | undefined;
  gitFacts: ReturnType<typeof createGitReader>;
  findPages: ReturnType<typeof createFindPages>;
  keepCatalog: (catalog: Label[]) => void;
  labelCatalog: () => Map<string, Label> | undefined;
  followLabel: (previousName: string, newName: string | undefined) => Promise<unknown>;
  log: ReturnType<typeof createLogger>;
}): Record<WorkspaceMethod, WorkspaceHandler> {
  const gitCall = <T>(run: (reader: NonNullable<typeof gitReader>) => Promise<T>) => {
    if (!gitReader) throw new RpcError(ERROR.unavailable, 'Registry needs ALP_HOME');
    return run(gitReader);
  };
  const registryList = async (kind: 'projects' | 'workspaces', params: any = {}) => registryCall(async () => {
    const r = await registry!.snapshot();
    const allowed = params.projectRoots;
    let entries: any[] = r[kind].filter((e: any) => kind === 'projects' ? params.includeRemoved || !e.removedAt : params.includeArchived || (!e.archivedAt && !r.projects.find(p => p.id === e.projectId)?.removedAt));
    if (allowed !== undefined) {
      entries = (await Promise.all(entries.map(async e => {
        const directory = kind === 'projects' ? e.root : e.directory;
        const canonical = await fsRealpath(directory).catch(() => undefined);
        return canonical && (!e.canonical || canonical === e.canonical) && allowed.includes(canonical) ? e : undefined;
      }))).filter(Boolean);
    }
    const offset = params.cursor === undefined ? 0 : Number(params.cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RpcError(-32602, 'Invalid registry cursor');
    const limit = params.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RpcError(-32602, 'Invalid registry limit');
    return { [kind]: await Promise.all(entries.slice(offset, offset + limit).map(async e => ({ ...(kind === 'workspaces' ? await workspaceDescriptor(e) : e), revision: r.revision }))), revision: r.revision, total: entries.length, nextCursor: offset + limit < entries.length ? String(offset + limit) : null };
  });
  const registryMutation = (method: string, p: any) => registryCall(async () => {
    if (!Number.isSafeInteger(p.ifRevision) || p.ifRevision < 0) throw new RpcError(-32602, 'ifRevision is required');
    const { requestId, ifRevision, authorizedRoots, ...args } = p;
    const result = await registry!.mutate(method, args, { requestId, ifRevision, allowedRoots: authorizedRoots });
    return result.workspace ? { ...result, workspace: await workspaceDescriptor(result.workspace) } : result;
  });
  /**
   * One workspace.files.list or read call: projectRoot checked, refusals answered with their code
   * and reason, any other failure with a fixed message (it may name a host path; alpd logs it).
   */
  async function filesCall<T>(projectRoot: unknown, read: () => Promise<T>): Promise<T> {
    if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot) || path.resolve(projectRoot) !== projectRoot) {
      throw new RpcError(RPC_ERROR.invalidParams, 'projectRoot must be an absolute, normalized path', { reason: 'invalid_path' });
    }
    try {
      return await read();
    } catch (error) {
      if (error instanceof FileAccessError) throw new RpcError(error.code, error.message, { reason: error.reason });
      if (error instanceof FilesError) throw new RpcError(ERROR.notFound, error.message, { reason: 'not_directory' });
      log.error('workspace file read failed', { code: 'ALPD_FILES_FAILED', error });
      throw new RpcError(ERROR.failed, 'alpd could not read the workspace file');
    }
  }
  return {
    /**
     * The files of a directory whose path matches a query, read-only and confined to it: no link
     * is followed, only names are read (docs/protocol/alp-json-rpc-v1.md §12.3, ALPD §15).
     */
    async 'workspace.files.search'(_connection, { projectRoot, query, limit } = {}) {
      if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot) || path.resolve(projectRoot) !== projectRoot) {
        throw new RpcError(RPC_ERROR.invalidParams, 'projectRoot must be an absolute, normalized path', { reason: 'invalid_path' });
      }
      try {
        return await searchWorkspaceFiles(projectRoot, { query, limit });
      } catch (error) {
        if (error instanceof FilesError) throw new RpcError(ERROR.notFound, error.message, { reason: 'not_directory' });
        throw error;
      }
    },

    /**
     * The entries of a directory under projectRoot, and the content of a text file there:
     * read-only, confined to it, no link followed, blocked paths always refused, .gitignore'd ones
     * unless includeIgnored (docs/protocol/alp-json-rpc-v1.md §12.4, ALPD §15).
     */
    async 'workspace.files.list'(_connection, { projectRoot, path: relative, includeIgnored, cursor, internalLinks } = {}) {
      return filesCall(projectRoot, () => listWorkspaceDirectory(projectRoot, { path: relative, includeIgnored: includeIgnored === true, cursor, internalLinks: internalLinks === true }));
    },
    async 'workspace.files.read'(_connection, { projectRoot, path: relative, includeIgnored } = {}) {
      return filesCall(projectRoot, () => readWorkspaceFile(projectRoot, { path: relative, includeIgnored: includeIgnored === true }));
    },

    /**
     * Every name under projectRoot in pages of a snapshot kept for this connection, and a file's
     * preview in chunks (docs/protocol/alp-json-rpc-v1.md §12.11): what the Paseo bridge's Files
     * panel and suggestions read, confined as workspace.files.read is. The gateway exposes neither.
     */
    async 'workspace.files.find'(connection, { projectRoot, query, kinds, matchMode, limit, cursor } = {}) {
      return filesCall(projectRoot, () => findPages(connection, projectRoot, { query, kinds, matchMode, limit, cursor }));
    },
    async 'workspace.files.preview'(_connection, { projectRoot, path: relative, includeIgnored, internalLinks, maxBytes, offset, revision } = {}) {
      return filesCall(projectRoot, () => previewWorkspaceFile(projectRoot, { path: relative, includeIgnored: includeIgnored === true, internalLinks: internalLinks === true, maxBytes, offset, revision }));
    },

    /** The host's directories for the folder to add as a project (§12.11): the owner's own names, never remote. */
    async 'host.directories.search'(_connection, { query, limit } = {}) {
      return searchHostDirectories(query, { limit });
    },

    'registry.owner': (_c, params) => registryCall(async () => {
      const result = params.operation ? await registry!.mutate(params.operation, params.args ?? {}, { requestId: params.requestId, ifRevision: params.ifRevision }) : undefined;
      const { receipts: _receipts, ...metadata } = await registry!.snapshot();
      keepCatalog(metadata.labels.catalog);
      // Roots carry catalog labels too (session.update): they follow a rename and lose a deleted one.
      // Only while the old name is gone from the catalog: a replayed receipt must not take a label
      // created again under that name from the roots that carry it now.
      const gone = (name: unknown): name is string => typeof name === 'string' && !labelCatalog()?.has(name.toLowerCase());
      if (params.operation === 'label.update' && gone(result?.previousName) && typeof result.label?.name === 'string') await followLabel(result.previousName, result.label.name);
      if (params.operation === 'label.delete' && gone(params.args?.name)) await followLabel(params.args.name, undefined);
      return { ...(result ? { result } : {}), registry: metadata };
    }),
    'registry.worktree': (_c, p) => registryCall(async () => worktrees ? worktrees.grants(p) : { mappings: [], workspaces: [] }),
    'workspace.worktree.options': (_c, p) => registryCall(async () => { const w = (await registry!.snapshot()).workspaces.find(w => w.id === p.workspaceId); if (!w) throw new RegistryError(1001, 'No workspace', { reason: 'not_found' }); const grants = worktrees ? await worktrees.grants(p) : { mappings: [], workspaces: [] }; return { mappingIds: grants.mappings.filter(m => m.source === (w.canonical ?? w.directory)).map(m => m.id) }; }),
    'workspace.worktree.create': (_c, p) => registryCall(async () => { if (!worktrees) throw new RegistryError(1005, 'Worktrees are unavailable on this platform', { reason: 'worktrees_unsupported' }); const result = await worktrees.mutate('create', p, p); return { ...result, workspace: await workspaceDescriptor(result.workspace) }; }),
    'workspace.worktree.remove': (_c, p) => registryCall(async () => { if (!worktrees) throw new RegistryError(1005, 'Worktrees are unavailable on this platform', { reason: 'worktrees_unsupported' }); const result = await worktrees.mutate('remove', p, p); return { ...result, workspace: await workspaceDescriptor(result.workspace) }; }),
    'workspace.git.status': (_c, p) => gitCall(reader => reader.status(p.workspaceId)),
    'workspace.git.diff': (_c, p) => gitCall(reader => reader.diff({ workspaceId: p.workspaceId, compare: p.compare, path: p.path, cursor: p.cursor })),
    'workspace.git.facts': (c, p) => agentRefused(c, 'workspace.git.facts') ?? gitFacts.facts(p.directory),
    'project.list': (_c, p) => registryList('projects', p),
    'workspace.list': (_c, p) => registryList('workspaces', p),
    'workspace.get': (_c, p) => registryCall(async () => {
      await registry!.resolve(p.workspaceId, undefined, true);
      const r = await registry!.snapshot();
      return { workspace: { ...await workspaceDescriptor(r.workspaces.find(w => w.id === p.workspaceId)), revision: r.revision }, revision: r.revision };
    }),
    'project.register': (_c, p) => registryMutation('project.register', p),
    'project.remove': (_c, p) => registryMutation('project.remove', p),
    'workspace.update': (_c, p) => registryMutation('workspace.update', p),
  };
}
