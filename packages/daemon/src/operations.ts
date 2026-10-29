import { createHash, createHmac, randomBytes } from 'node:crypto';
import { lstat, stat } from 'node:fs/promises';
import path from 'node:path';
import { CAPABILITY, ERROR, RPC_ERROR } from '@anhlp/alp-protocol';
import { closeTask, createTask, epicReport, loadTasks, rejectGate, reopenTask, resolveGate } from '@anhlp/alp-core/tasks';
import { taskRows } from '@anhlp/alp-core/task-rows';
import { deleteEntry, duplicateEntry, getEntry, listEntries, renameEntry, saveEntry, setGivenSkills } from '@anhlp/alp-core/library-edit';
import { listTeams } from '@anhlp/alp-core/teams';
import { catalogEntries } from '@anhlp/alp-runtime/index';
import { listProviders } from '@anhlp/alp-core/providers';
import { languageSetting, setLanguage, LANGUAGE_CHARS } from '@anhlp/alp-core/user-settings';
import { syncProjectSettings } from '@anhlp/alp-core/init';
import { RpcError } from './rpc-error.js';

/**
 * The project, task, library and settings methods (docs/protocol/alp-json-rpc-v1.md §12, §15):
 * what a client needs besides sessions, answered from the daemon host's own files so a remote
 * client never reads ALP_HOME or a project. The business logic is core's; alpd resolves the
 * project, serializes its own writes, maps core's refusals to protocol errors and keeps
 * secrets out of what it answers. The schema has checked every param before a handler runs.
 */

export type OperationsOptions = {
  /** The daemon user's ALP_HOME: their library and settings.json. Without it only task.* is served. */
  home?: string;
  /** ALP's built-in agents and teams. */
  templates?: Record<string, string>;
  /** Project roots the daemon knows from its session records, for a team save's sync. */
  knownProjects?: () => Iterable<string>;
  /** A gate changed through task.gate.resolve: the runtime syncs the project's gate cards and mail. */
  onGateChange?: (projectRoot: string) => Promise<void> | void;
};

type Handler = (params: any) => Promise<unknown>;

/** How long task.create remembers a requestId (§10): within one alpd process only. */
const REQUEST_TTL_MS = 10 * 60 * 1000;
/** At most this many remembered requestIds; the oldest go first. */
const MAX_REQUESTS = 10_000;
const MARKER = '$secret';
const KEEP = 'keep';

/** Secret-bearing maps of each kind's content: their values never leave alpd. */
const SECRET_MAPS: Record<string, string[][]> = {
  mcp: [['server', 'env'], ['server', 'headers']],
  providers: [['provider', 'env']],
};

const failure = (code: number, reason: string, message: string, extra: object = {}) => new RpcError(code, message, { reason, ...extra });

/** Core refusals (AlpError codes) as protocol errors; `context` decides what an ambiguous one means. */
function fromCore(error: any, context: { notFound?: 'not_found' | 'invalid_entry' } = {}): unknown {
  if (error instanceof RpcError || typeof error?.code !== 'string' || error?.name !== 'AlpError') return error;
  const message = error.message as string;
  switch (error.code) {
    case 'UNSAFE_LIBRARY_WRITE': return failure(ERROR.forbidden, 'library_policy', message);
    case 'UNSAFE_PATH': return failure(ERROR.forbidden, 'unsafe_path', message);
    case 'TASK_NOT_FOUND': return failure(ERROR.notFound, 'unknown_task', message);
    case 'TASK_CHANGED': case 'REVISION_CONFLICT': return failure(ERROR.conflict, 'revision_conflict', message);
    case 'INVALID_TASK': case 'TASK_CYCLE': case 'TASK_TAKEN': case 'TASK_UNVERIFIED': return failure(ERROR.conflict, 'task_state', message);
    case 'TASKS_LOCKED': return failure(ERROR.unavailable, 'busy', message);
    case 'IN_USE': return failure(ERROR.conflict, 'in_use', message);
    case 'INVALID_SCOPE': return failure(RPC_ERROR.invalidParams, 'invalid_scope', message);
    case 'INVALID_LIBRARY': case 'INVALID_SETTINGS': return failure(ERROR.failed, 'unreadable', message);
  }
  if (error.code === 'NOT_FOUND' || error.code.endsWith('_NOT_FOUND')) {
    return context.notFound === 'invalid_entry' ? failure(RPC_ERROR.invalidParams, 'invalid_entry', message) : failure(ERROR.notFound, 'not_found', message);
  }
  if (error.code.startsWith('INVALID_')) return failure(RPC_ERROR.invalidParams, 'invalid_entry', message);
  return error;
}

const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const pointer = (parts: string[]) => parts.map(part => `/${part.replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
const isMarker = (value: unknown) => object(value) && Object.keys(value).length === 1 && value[MARKER] === KEEP;
const at = (content: unknown, parts: string[]) => parts.reduce<any>((value, part) => object(value) ? value[part] : undefined, content);

/** A copy of an entry's content with each stored secret replaced by the marker, and where they were. */
function redact(kind: string, content: Record<string, unknown>) {
  const copy = structuredClone(content);
  const secrets: string[] = [];
  for (const parts of SECRET_MAPS[kind] ?? []) {
    const map = at(copy, parts);
    if (!object(map)) continue;
    for (const key of Object.keys(map)) {
      if (typeof map[key] !== 'string') continue;
      map[key] = { [MARKER]: KEEP };
      secrets.push(pointer([...parts, key]));
    }
  }
  return { content: copy, secrets };
}

/**
 * The content a save writes: a marker keeps the value stored at its place in `previous` (the entry
 * the save replaces, or the one that applies when the scope has none yet), a string replaces it, a
 * missing key removes it. A marker anywhere else, or with nothing stored to keep, refuses the save,
 * so a placeholder never reaches storage.
 */
function unredact(kind: string, content: Record<string, unknown>, previous: Record<string, unknown> | undefined) {
  const next = structuredClone(content);
  for (const parts of SECRET_MAPS[kind] ?? []) {
    const map = at(next, parts);
    if (!object(map)) continue;
    const stored = at(previous, parts);
    for (const key of Object.keys(map)) {
      if (!isMarker(map[key])) continue;
      const value = object(stored) ? stored[key] : undefined;
      if (typeof value !== 'string') throw failure(RPC_ERROR.invalidParams, 'secret_marker', `There is no stored value of ${pointer([...parts, key])} to keep; send the value instead`);
      map[key] = value;
    }
  }
  const stray = (value: unknown, parts: string[]): string | undefined => {
    if (isMarker(value) || (object(value) && Object.hasOwn(value, MARKER))) return pointer(parts);
    if (Array.isArray(value)) for (const [index, item] of value.entries()) { const found = stray(item, [...parts, String(index)]); if (found) return found; }
    if (object(value)) for (const [key, item] of Object.entries(value)) { const found = stray(item, [...parts, key]); if (found) return found; }
    return undefined;
  };
  const found = stray(next, []);
  if (found !== undefined) throw failure(RPC_ERROR.invalidParams, 'secret_marker', `${found || 'content'} holds a secret marker where no secret is kept`);
  return next;
}

export function createOperations({ home, templates, knownProjects = () => [], onGateChange }: OperationsOptions = {}) {
  /** Revisions on the wire are keyed per alpd process, so they never carry a hash of secret content. */
  const revisionKey = randomBytes(32);
  const toWire = (revision: string | null | undefined) => revision == null ? null : `r${createHmac('sha256', revisionKey).update(revision).digest('base64url').slice(0, 22)}`;
  /** alpd's own writes to the library, settings and projects' .alp happen one at a time. */
  let writes: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = writes.catch(() => {}).then(work);
    writes = run;
    return run;
  };
  const requests = new Map<string, { fingerprint: string; at: number; result: Promise<{ id: string }> }>();

  /**
   * A project as params name it: an absolute, normalized path to a directory holding a real .alp
   * directory. alpd never walks up to a parent, so the path a caller authorizes is the one used.
   */
  async function project(value: string) {
    if (!path.isAbsolute(value) || path.resolve(value) !== value) throw failure(RPC_ERROR.invalidParams, 'invalid_path', 'projectRoot must be an absolute, normalized path');
    if (!(await stat(value).catch(() => undefined))?.isDirectory()) throw failure(ERROR.notFound, 'not_alp_project', `${value} is not a directory`);
    const alp = await lstat(path.join(value, '.alp')).catch(() => undefined);
    if (alp?.isSymbolicLink()) throw failure(ERROR.forbidden, 'unsafe_path', `${path.join(value, '.alp')} is a symlink`);
    if (!alp?.isDirectory()) throw failure(ERROR.notFound, 'not_alp_project', `${value} is not an ALP project; run alp init there`);
    return value;
  }

  async function where(projectRoot: string | undefined, scope?: string) {
    if (scope === 'project' && projectRoot === undefined) throw failure(RPC_ERROR.invalidParams, 'invalid_scope', 'scope project needs projectRoot');
    return { root: projectRoot === undefined ? undefined : await project(projectRoot), library: home, templates };
  }

  /** One layer's version of an entry, or undefined. */
  async function layer(kind: string, name: string, options: object, scope?: string) {
    try { return await getEntry(kind as any, name, { ...options, ...(scope ? { scope } : {}) } as any); }
    catch (error: any) { if (error?.code === 'NOT_FOUND') return undefined; throw error; }
  }

  const guard = (handler: Handler, context?: Parameters<typeof fromCore>[1]): Handler => async params => {
    try { return await handler(params); }
    catch (error) { throw fromCore(error, context); }
  };

  const taskHandlers: Record<string, Handler> = {
    'task.list': guard(async ({ projectRoot }) => {
      const root = await project(projectRoot);
      const { tasks, unreadable } = await taskRows(root);
      return { projectRoot: root, tasks, unreadable, revision: createHash('sha256').update(JSON.stringify([tasks, unreadable])).digest('hex').slice(0, 16) };
    }),

    'task.create': guard(async ({ projectRoot, title, priority, requestId }) => {
      const root = await project(projectRoot);
      const create = () => createTask(root, { title: title.trim(), ...(priority !== undefined ? { priority } : {}) }, 'user').then(task => ({ id: task.id }));
      if (requestId === undefined) return create();
      const now = Date.now();
      for (const [key, entry] of requests) if (now - entry.at > REQUEST_TTL_MS) requests.delete(key);
      const key = JSON.stringify([root, requestId]);
      const fingerprint = JSON.stringify([title.trim(), priority ?? null]);
      const existing = requests.get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw failure(ERROR.conflict, 'key_conflict', `Request ${requestId} was already used for another task`);
        return { ...await existing.result, duplicate: true as const };
      }
      const result = create();
      if (requests.size >= MAX_REQUESTS) requests.delete(requests.keys().next().value!);
      requests.set(key, { fingerprint, at: now, result });
      // A create that failed made nothing: the same requestId may try again.
      result.catch(() => { if (requests.get(key)?.result === result) requests.delete(key); });
      return result;
    }),

    'task.update': guard(async ({ projectRoot, id, action, note, ifRev }) => {
      const root = await project(projectRoot);
      const options = ifRev !== undefined ? { ifRev } : undefined;
      if (action === 'reopen') {
        const task = await reopenTask(root, id, { ...(note ? { note } : {}) }, 'user', options);
        return { id: task.id, status: task.status, rev: task.rev };
      }
      const task = await closeTask(root, id, { reason: 'done', ...(note ? { summary: note } : {}) }, 'user', options);
      const { tasks } = await loadTasks(root);
      const landed = tasks.some(entry => entry.parent === task.id) ? epicReport(task.id, tasks).text.split('\n')[0] : undefined;
      return { id: task.id, status: task.status, rev: task.rev, ...(landed ? { landed } : {}) };
    }),

    // Approves a gate, or with reject records the user's rejection and leaves it open. Either way
    // the runtime is told, so main gets the decision by mail once and the gate's card settles.
    'task.gate.resolve': guard(async ({ projectRoot, id, gate, note, ifRev, choice, reject, channel = 'web' }) => {
      const root = await project(projectRoot);
      const guarded = ifRev !== undefined ? { ifRev } : {};
      const task = reject === true
        ? await rejectGate(root, id, gate, { by: 'user', channel, ...(note ? { reason: note } : {}), ...guarded })
        : await resolveGate(root, id, gate, { by: 'user', channel, ...(note ? { note } : {}), ...(choice !== undefined ? { choice } : {}), ...guarded });
      await onGateChange?.(root);
      return { id: task.id, status: task.status, rev: task.rev };
    }),
  };

  const libraryHandlers: Record<string, Handler> = {
    'team.list': guard(async ({ projectRoot }) => {
      const { root } = await where(projectRoot);
      const teams = await listTeams(root, { library: home, templates });
      return { projectRoot: root ?? null, teams: teams.map(({ path: _path, ...team }) => team) };
    }),

    'library.list': guard(async ({ kind, projectRoot }) => {
      const options = await where(projectRoot);
      const entries = await listEntries(kind, options);
      return { projectRoot: options.root ?? null, entries: entries.map(({ path: _path, ...entry }: any) => entry) };
    }),

    'library.get': guard(async ({ kind, name, projectRoot, scope }) => {
      const options = await where(projectRoot, scope);
      const entry = await getEntry(kind, name, { ...options, ...(scope ? { scope } : {}) });
      const { content, secrets } = redact(kind, entry.content);
      return { ...entry, content, revision: toWire(entry.revision), ...(secrets.length ? { secrets } : {}) };
    }),

    'library.save': guard(({ kind, name, scope, projectRoot, content, revision, policy, sync = 'none' }) => serial(async () => {
      if (policy === 'project-data' && sync !== 'none') throw failure(ERROR.forbidden, 'library_policy', 'Project-data writes cannot synchronize projects');
      const options = await where(projectRoot, scope);
      const current = await layer(kind, name, options, scope);
      if (revision !== undefined && revision !== toWire(current?.revision ?? null)) {
        throw failure(ERROR.conflict, 'revision_conflict', current === undefined ? `${kind} '${name}' is not in the ${scope}` : revision === null ? `${kind} '${name}' already exists in the ${scope}` : `${kind} '${name}' changed in the ${scope} since you opened it; reload it and apply your change again`);
      }
      const previous = current?.content ?? (await layer(kind, name, options))?.content;
      const next = unredact(kind, content, previous);
      // Core checks the revision again as it writes, against writers outside alpd.
      const saved = await saveEntry(kind, name, next, { ...options, scope, policy, ...(revision !== undefined ? { revision: current?.revision ?? null } : {}) });
      if (kind !== 'teams' || sync !== 'known-projects') return { revision: toWire(saved.revision) };
      const roots = new Set<string>(options.root ? [options.root] : []);
      if (scope === 'library') for (const root of knownProjects()) if (typeof root === 'string' && path.isAbsolute(root)) roots.add(path.resolve(root));
      let syncedProjects = 0;
      const syncErrors: string[] = [];
      for (const root of roots) {
        try { if (await syncProjectSettings(root, { library: home, templates, teamIds: [name], replaceModels: true })) syncedProjects += 1; }
        catch (error) { syncErrors.push(`${root}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      return { revision: toWire(saved.revision), syncedProjects, syncErrors };
    }), { notFound: 'invalid_entry' }),

    'library.delete': guard(({ kind, name, scope, projectRoot, revision, policy }) => serial(async () => {
      const options = await where(projectRoot, scope);
      const current = await layer(kind, name, options, scope);
      if (!current) throw failure(ERROR.notFound, 'not_found', `No ${kind} entry '${name}' in the ${scope}`);
      if (revision !== undefined && revision !== toWire(current.revision)) throw failure(ERROR.conflict, 'revision_conflict', `${kind} '${name}' changed in the ${scope} since you opened it`);
      return deleteEntry(kind, name, { ...options, scope, policy, ...(revision !== undefined ? { revision: current.revision } : {}) });
    })),

    'library.duplicate': guard(({ kind, from, to, scope, projectRoot, policy }) => serial(async () => {
      const options = await where(projectRoot, scope);
      try { await getEntry(kind, from, options); }
      catch (error) { throw fromCore(error, { notFound: 'not_found' }); }
      return { revision: toWire((await duplicateEntry(kind, from, to, { ...options, scope, policy })).revision) };
    }), { notFound: 'invalid_entry' }),

    'library.rename': guard(({ kind, from, to, scope, projectRoot, policy }) => serial(async () => {
      const options = await where(projectRoot, scope);
      return { revision: toWire((await renameEntry(kind, from, to, { ...options, scope, policy })).revision) };
    })),

    'library.skills.set': guard(({ agent, skills }) => serial(() => setGivenSkills(agent, skills, { library: home })), { notFound: 'invalid_entry' }),

    'library.models': guard(async () => {
      const models: Array<{ id: string; label: string; efforts: string[]; effort?: string }> = catalogEntries.map(model => ({ id: `${model.runtime}:${model.id}`, label: `${model.runtime} · ${model.label}`, efforts: model.efforts, ...(model.effort ? { effort: model.effort } : {}) }));
      for (const provider of await listProviders(home)) {
        if (provider.enabled === false || provider.kind === 'antigravity') continue;
        models.push({ id: `acp:${provider.id}`, label: `${provider.label} · Provider default`, efforts: [] });
        for (const model of [...(provider.models ?? []), ...(provider.additionalModels ?? [])]) models.push({ id: `acp:${provider.id}/${model.id}`, label: `${provider.label} · ${model.label ?? model.id}`, efforts: [] });
      }
      return { models: [...new Map(models.map(model => [model.id, model])).values()] };
    }),

    'settings.language.get': guard(async () => languageSetting(home!)),

    'settings.language.set': guard(async ({ language }) => {
      if (language !== null && language.trim().length > LANGUAGE_CHARS) throw failure(RPC_ERROR.invalidParams, 'invalid_params', `A language is a name of at most ${LANGUAGE_CHARS} characters`);
      return serial(() => setLanguage(home!, language));
    }),
  };

  const library = home !== undefined;
  return {
    handlers: { ...taskHandlers, ...(library ? libraryHandlers : {}) },
    capabilities: [CAPABILITY.task, ...(library ? [CAPABILITY.team, CAPABILITY.library, CAPABILITY.libraryProjectWrite, CAPABILITY.settingsLanguage] : [])],
  };
}
