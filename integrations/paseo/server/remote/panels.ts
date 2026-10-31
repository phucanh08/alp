import type { PluginServerContext } from '../compat.js';
import { sessionTasks } from '../session-tasks.js';
import { tasksAdd, tasksChange, tasksList, type TaskRow } from '../../shared/tasks.js';
import { languageGet, languageSet, libraryDelete, libraryDuplicate, libraryGet, libraryList, libraryModels, libraryRename, librarySave, librarySkills, libraryTest } from '../../shared/library.js';
import { usageGet } from '../../shared/usage.js';
import { agentCompact, compactFirst } from '../../shared/compact.js';
import { openGateway, workspaceFor, type GatewayConfig, type GatewayLink, type Principal } from './link.js';

/**
 * The plugin's panels in remote mode (docs/alp/paseo-remote.md §4): the same RPC contracts the
 * client bundle calls (shared/*.ts), answered from alpd through the gateway instead of this
 * machine's files. What the gateway does not expose answers a clear "unavailable in remote mode"
 * error the panel shows; nothing is read or written here instead.
 */

/** The prefix of every refusal of a feature the remote mode does not have. */
export const UNAVAILABLE = 'Unavailable in ALP remote mode';

export class RemoteUnavailableError extends Error {
  constructor(what: string, where: string) {
    super(`${UNAVAILABLE}: ${what}. ${where}`);
    this.name = 'RemoteUnavailableError';
  }
}

const ON_HOST = 'Do this on the ALP host (the alp CLI or the ALP web app there).';

/** What the settings screens show instead of their edit actions in remote mode. */
const READ_ONLY = `ALP remote mode: the library of the ALP host is viewed here with secrets hidden; changes and tests require the ALP host. ${ON_HOST}`;

/**
 * One connection to alpd for the panels, opened when first needed and again after it closed. A
 * request that failed is not sent again: the panel shows the error and the user tries again.
 */
export function remoteLink(config: GatewayConfig, info: { name: string; version: string }, open = openGateway) {
  let link: Promise<GatewayLink> | undefined;
  const current = () => {
    link ??= open(config, info).then(opened => {
      opened.client.onClose(() => { link = undefined; });
      return opened;
    }, error => { link = undefined; throw error; });
    return link;
  };
  return {
    async request<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      const { client } = await current();
      return client.request(method, params) as Promise<T>;
    },
    async principal(): Promise<Principal> { return (await current()).principal; },
    close() { void link?.then(opened => opened.client.close(), () => {}); link = undefined; },
  };
}

export type RemoteLink = ReturnType<typeof remoteLink>;

/** The granted workspace a panel's directory lies in, as the projectRoot alpd is asked about. */
async function project(link: RemoteLink, directory: string | undefined) {
  const principal = await link.principal();
  return workspaceFor(principal, directory)?.path;
}

export function registerRemoteTaskRpc(server: PluginServerContext, link: RemoteLink) {
  server.handle(tasksList, async ({ directory }) => {
    const projectRoot = await project(link, directory);
    if (!projectRoot) return { projectRoot: null, tasks: [], unreadable: [] };
    const { tasks, unreadable } = await link.request('task.list', { projectRoot });
    const known = new Set((tasks as TaskRow[]).map(task => task.id));
    const sessions = Object.fromEntries([...sessionTasks].map(([id, worked]) => [id, worked.filter(task => known.has(task))]).filter(([, worked]) => worked.length));
    return { projectRoot, tasks: tasks as TaskRow[], unreadable, sessions };
  });

  server.handle(tasksAdd, async ({ directory, title, priority }) => {
    const projectRoot = await project(link, directory);
    if (!projectRoot) throw new Error(`${directory} is not in a workspace your ALP credential grants`);
    // A requestId lets alpd answer a repeat within its process; the panel itself never repeats.
    return link.request('task.create', { projectRoot, title, ...(priority !== undefined ? { priority } : {}), requestId: `paseo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}` });
  });

  server.handle(tasksChange, async ({ directory, id, action, gate, note, choice }) => {
    const projectRoot = await project(link, directory);
    if (!projectRoot) throw new Error(`${directory} is not in a workspace your ALP credential grants`);
    if (action === 'approve' || action === 'reject') {
      const { id: done, status } = await link.request('task.gate.resolve', { projectRoot, id, gate: gate ?? '', channel: 'paseo', ...(action === 'reject' ? { reject: true } : {}), ...(note ? { note } : {}), ...(choice ? { choice } : {}) });
      return { id: done, status };
    }
    const { id: done, status, landed } = await link.request('task.update', { projectRoot, id, action, ...(note ? { note } : {}) });
    return { id: done, status, ...(landed ? { landed } : {}) };
  });
}

export function registerRemoteLibraryRpc(server: PluginServerContext, link: RemoteLink) {
  server.handle(libraryModels, async () => {
    const { models } = await link.request('library.models');
    return { models };
  });
  server.handle(libraryList, async ({ directory, kind }) => {
    const projectRoot = await project(link, directory);
    // Without a granted workspace there is nothing alpd may list for this credential: say so, with no entries.
    if (!projectRoot) return { projectRoot: null, library: 'the ALP host', entries: [], readOnly: { reason: READ_ONLY, unlisted: 'Open a workspace your ALP credential grants to list the host library here.' } };
    const { entries } = await link.request('library.list', { kind, projectRoot });
    // Rows name entries only (the gateway keeps their content and host paths in).
    return { projectRoot, library: 'the ALP host', entries, readOnly: { reason: READ_ONLY } };
  });
  // One entry, read only, as the granted workspace's sessions use it. The gateway projects its
  // content (t-7679.14): each field that can hold a secret answers as a secret marker listed in `secrets`.
  server.handle(libraryGet, async ({ directory, kind, name, scope }) => {
    const projectRoot = await project(link, directory);
    if (!projectRoot) throw new Error(`${directory ?? 'This screen'} is not in a workspace your ALP credential grants; open one to read the host library`);
    const entry = await link.request('library.get', { kind, name, projectRoot, ...(scope ? { scope } : {}) });
    return {
      kind: entry.kind, name: entry.name, source: entry.source, ...(entry.overrides ? { overrides: entry.overrides } : {}),
      content: entry.content, revision: entry.revision ?? null, usedBy: entry.usedBy ?? [],
      ...(entry.librarySkills ? { librarySkills: entry.librarySkills } : {}),
      ...(entry.secrets ? { secrets: entry.secrets } : {}),
    };
  });
  for (const contract of [librarySave, libraryDelete, libraryDuplicate, libraryRename]) {
    server.handle(contract as typeof librarySave, async () => { throw new RemoteUnavailableError('changing the library', ON_HOST); });
  }
  server.handle(librarySkills, async () => { throw new RemoteUnavailableError('giving skills to roles', ON_HOST); });
  server.handle(libraryTest, async () => { throw new RemoteUnavailableError('testing MCP servers, hooks and providers (they would run on the ALP host)', ON_HOST); });
  server.handle(languageGet, async () => ({ ...(await link.request('settings.language.get')), readOnly: `${UNAVAILABLE}: changing the language. ${ON_HOST}` }));
  server.handle(languageSet, async () => { throw new RemoteUnavailableError('changing the language', ON_HOST); });
}

export function registerRemoteUsageRpc(server: PluginServerContext) {
  server.handle(usageGet, async () => { throw new RemoteUnavailableError('provider usage (it is account-wide on the ALP host)', 'See it on the ALP host with alp usage.'); });
}

/** Compact context through the gateway (t-de1a): session.write on a root in the grant, as the gateway checks. */
export function registerRemoteCompactRpc(server: PluginServerContext, link: RemoteLink) {
  server.handle(agentCompact, async ({ sessions }) => compactFirst((method, params) => link.request(method, params), sessions));
}
