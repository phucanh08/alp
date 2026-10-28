// Adapted from Paseo (https://github.com/getpaseo/paseo, commit b63a325, packages/server/src/server/utils/diff-highlighter.ts),
// Copyright (c) 2025-present Mohamed Boudra, Apache License 2.0 (integrations/paseo/LICENSE.paseo.txt).
// Changed for ALP: the unified-diff parser consumes alpd diff pages; Git operations stay in alpd.

import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { SessionInboundMessage, SessionOutboundMessage } from '@getpaseo/protocol/messages';
import type { GitDiffFile, GitDiffPage, GitStatus } from '@anhlp/alp-protocol';
import type { ClientContext, Handler } from './gateway.js';

/**
 * A checkout's git state and changes for the app (D31 step 8, ALPD §62): the branch, base and how
 * far apart they are for the header, and the Changes panel's diff, uncommitted or against the
 * base branch, pushed again when the checkout changes. Read-only: committing, pushing, pulling,
 * merging and switching branches answer "in development".
 *
 * The bridge runs no Git itself (issue #121, G1): it finds the registry workspace of the `cwd` it
 * is asked about and asks alpd, whose `workspace.git.status` and `workspace.git.diff` run Git
 * boxed in (docs/protocol/alp-json-rpc-v1.md §12.5), then answers in Paseo's shapes. A daemon
 * without them (capability `workspace.git`) is answered with Paseo's error shape, never with a Git
 * of the bridge's own. Where Paseo's view differs from what alpd shows, on purpose:
 * - only a registry workspace's own directory, at its repository's top level, is a checkout: an
 *   unknown directory, or one inside a repository, answers "not git" with an error;
 * - `repoRoot` is the directory asked about (it is the top level), `mainRepoRoot` null;
 * - a change to a blocked path (`.env`, keys, credentials, either side of a rename) is not listed;
 *   a file holding a private key, a symbolic link and a submodule show no content (`binary`);
 * - `remoteUrl` has no credentials, and is null for a local path remote;
 * - `upstreamRef` is the full ref of alpd's short upstream (`origin/main` → refs/remotes/origin/main;
 *   a name without a slash → refs/heads/<name>);
 * - one diff answer holds alpd's first page (2 MiB as JSON): past it, `diffTooLarge` says so and
 *   the rest is not listed.
 */

type Inbound<T extends SessionInboundMessage['type']> = Extract<SessionInboundMessage, { type: T }>;
type Outbound = SessionOutboundMessage;
type StatusPayload = Extract<Outbound, { type: 'checkout_status_response' }>['payload'];
/** A status without its request id, each of the union's shapes kept apart. */
type Status = StatusPayload extends infer P ? P extends unknown ? Omit<P, 'requestId'> : never : never;
type DiffFile = Extract<Outbound, { type: 'checkout_diff_update' }>['payload']['files'][number];
type Hunk = DiffFile['hunks'][number];
type Compare = Inbound<'subscribe_checkout_diff_request'>['compare'];
type CheckoutError = { code: 'NOT_GIT_REPO' | 'NOT_ALLOWED' | 'MERGE_CONFLICT' | 'UNKNOWN'; message: string };
type Rpc = (method: string, params: any) => Promise<any>;

const POLL_MS = 3_000;
/** How long the directory → workspace answer is kept: polls do not read the registry every time. */
const WORKSPACE_TTL_MS = 5_000;

const notGit = (cwd: string, error: CheckoutError | null = null): Status => ({
  cwd, error, isGit: false, isPaseoOwnedWorktree: false, repoRoot: null, currentBranch: null, isDirty: null, baseRef: null, aheadBehind: null, aheadOfOrigin: null, behindOfOrigin: null, hasRemote: false, remoteUrl: null,
});

/** alpd's refusal as Paseo's error: its message is fixed by alpd (no host path, no content). */
function errorOf(error: any): CheckoutError {
  const reason = error?.data?.reason;
  if (error?.code === -32601) return { code: 'UNKNOWN', message: 'This ALP daemon cannot read Git state (workspace.git); restart it after upgrading' };
  if (reason === 'not_repository') return { code: 'NOT_GIT_REPO', message: String(error?.message ?? 'Not a git repository') };
  return { code: 'UNKNOWN', message: String(error?.message ?? error) };
}

class NotWorkspace extends Error {}

/** A hunk as Paseo shows it: a header line as Git writes it, then its lines. */
function hunkOf(hunk: GitDiffFile['hunks'][number]): Hunk {
  const range = (start: number, count: number) => (count === 1 ? `${start}` : `${start},${count}`);
  return {
    oldStart: hunk.oldStart, oldCount: hunk.oldCount, newStart: hunk.newStart, newCount: hunk.newCount,
    lines: [{ type: 'header', content: `@@ -${range(hunk.oldStart, hunk.oldCount)} +${range(hunk.newStart, hunk.newCount)} @@` }, ...hunk.lines.map(line => ({ type: line.type, content: line.content }))],
  };
}

export function fileOf(file: GitDiffFile): DiffFile {
  const status = file.kind === 'text' ? 'ok' : file.kind === 'too_large' ? 'too_large' : 'binary';
  return {
    path: file.path, ...(file.oldPath ? { oldPath: file.oldPath } : {}),
    isNew: file.change === 'added' || file.change === 'untracked' || file.change === 'copied', isDeleted: file.change === 'deleted',
    additions: file.additions, deletions: file.deletions, hunks: file.kind === 'text' ? file.hunks.map(hunkOf) : [], status,
  };
}

export function statusOf(cwd: string, status: GitStatus): Status {
  if (status.state === 'not_repository') return notGit(cwd);
  if (status.state !== 'repository') return notGit(cwd, { code: 'NOT_ALLOWED', message: 'ALP shows Git state only at a repository\'s top level' });
  const upstream = status.upstream;
  return {
    cwd, error: null, isGit: true, isPaseoOwnedWorktree: false, repoRoot: cwd, mainRepoRoot: null, currentBranch: status.branch, isDirty: status.dirty, baseRef: status.baseRef,
    aheadBehind: status.aheadBehind, aheadOfOrigin: upstream?.ahead ?? null, behindOfOrigin: upstream?.behind ?? null, hasRemote: status.hasRemote, remoteUrl: status.remoteUrl,
    upstreamRef: upstream ? (upstream.ref.includes('/') ? `refs/remotes/${upstream.ref}` : `refs/heads/${upstream.ref}`) : null,
  };
}

type Subscription = { client: ClientContext; subscriptionId: string; cwd: string; compare: Compare; last?: string };

export function createCheckouts({ broadcast, rpc, log = () => {} }: { broadcast(message: Outbound): void; rpc: Rpc; log?: (message: string) => void }) {
  const subscriptions = new Map<string, Subscription>();
  /** The status each directory last had, so a change goes to every client. */
  const statuses = new Map<string, string>();
  const workspaces = new Map<string, { at: number; id: Promise<string> }>();
  let timer: NodeJS.Timeout | undefined;

  /** The live registry workspace whose directory `cwd` is (the oldest, as placement picks). */
  async function lookup(cwd: string): Promise<string> {
    if (!path.isAbsolute(cwd)) throw new NotWorkspace();
    const { registry } = await rpc('registry.owner', {});
    const removed = new Set((registry?.projects ?? []).filter((project: any) => project.removedAt).map((project: any) => project.id));
    const live = (registry?.workspaces ?? []).filter((entry: any) => !entry.archivedAt && !removed.has(entry.projectId))
      .sort((a: any, b: any) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const lexical = path.resolve(cwd);
    const exact = live.find((entry: any) => entry.directory === lexical || entry.canonical === lexical);
    if (exact) return exact.id;
    const real = await realpath(lexical).catch(() => undefined);
    const found = real && live.find((entry: any) => (entry.canonical ?? entry.directory) === real);
    if (!found) throw new NotWorkspace();
    return found.id;
  }
  function workspaceOf(cwd: string): Promise<string> {
    const kept = workspaces.get(cwd);
    if (kept && Date.now() - kept.at < WORKSPACE_TTL_MS) return kept.id;
    const id = lookup(cwd);
    workspaces.set(cwd, { at: Date.now(), id });
    id.catch(() => workspaces.delete(cwd));
    return id;
  }

  async function checkoutStatus(cwd: string): Promise<Status> {
    try {
      const workspaceId = await workspaceOf(cwd);
      return statusOf(cwd, await rpc('workspace.git.status', { workspaceId }));
    } catch (error: any) {
      if (error instanceof NotWorkspace) return notGit(cwd, { code: 'NOT_ALLOWED', message: 'Not a workspace of this ALP daemon' });
      return notGit(cwd, errorOf(error));
    }
  }

  async function checkoutDiff(cwd: string, compare: Compare): Promise<{ files: DiffFile[]; error: CheckoutError | null; diffTooLarge?: boolean }> {
    let workspaceId: string;
    try { workspaceId = await workspaceOf(cwd); } catch (error) {
      if (error instanceof NotWorkspace) return { files: [], error: { code: 'NOT_ALLOWED', message: 'Not a workspace of this ALP daemon' } };
      return { files: [], error: errorOf(error) };
    }
    const wanted = { mode: compare.mode, ...(compare.mode === 'base' && compare.baseRef ? { baseRef: compare.baseRef } : {}), ...(compare.ignoreWhitespace ? { ignoreWhitespace: true } : {}) };
    let page: GitDiffPage;
    try {
      page = await rpc('workspace.git.diff', { workspaceId, compare: wanted });
    } catch (error: any) {
      // As before: a base branch that does not exist compares nothing.
      if (error?.data?.reason === 'unknown_ref' || error?.data?.reason === 'invalid_compare') return { files: [], error: null };
      return { files: [], error: errorOf(error) };
    }
    return { files: page.files.map(fileOf), error: null, ...(page.truncated ? { diffTooLarge: true } : {}) };
  }

  async function payloadOf(subscription: Subscription) {
    const { files, error, diffTooLarge } = await checkoutDiff(subscription.cwd, subscription.compare);
    return { subscriptionId: subscription.subscriptionId, cwd: subscription.cwd, files, error, ...(diffTooLarge ? { diffTooLarge } : {}) };
  }

  /** Reads each watched checkout again; what changed goes out. */
  async function poll(onlyCwd?: string) {
    if (onlyCwd) workspaces.delete(onlyCwd);
    for (const subscription of [...subscriptions.values()]) {
      if (onlyCwd && subscription.cwd !== onlyCwd) continue;
      const payload = await payloadOf(subscription);
      const text = JSON.stringify(payload);
      if (text === subscription.last || !subscriptions.has(subscription.subscriptionId)) continue;
      subscription.last = text;
      subscription.client.emit({ type: 'checkout_diff_update', payload });
    }
    for (const cwd of new Set([...subscriptions.values()].map(subscription => subscription.cwd).concat(onlyCwd ? [onlyCwd] : []))) {
      const status = await checkoutStatus(cwd);
      const text = JSON.stringify(status);
      if (statuses.get(cwd) === text) continue;
      const known = statuses.has(cwd);
      statuses.set(cwd, text);
      // Paseo's status shapes carry a request id even when pushed.
      if (known) broadcast({ type: 'checkout_status_update', payload: { ...status, requestId: `alp:status:${Date.now()}` } } as Outbound);
    }
  }

  function schedule() {
    if (timer || !subscriptions.size) return;
    timer = setInterval(() => void poll().catch(error => log(`checkouts not polled: ${error?.message ?? error}`)), POLL_MS);
    timer.unref();
  }

  const handlers: Record<string, Handler> = {
    async checkout_status_request(message: Inbound<'checkout_status_request'>) {
      const status = await checkoutStatus(message.cwd);
      statuses.set(message.cwd, JSON.stringify(status));
      return { type: 'checkout_status_response', payload: { ...status, requestId: message.requestId } } as Outbound;
    },

    /** The Changes panel: the diff now, then again whenever it changes, until unsubscribed. */
    async subscribe_checkout_diff_request(message: Inbound<'subscribe_checkout_diff_request'>, client: ClientContext) {
      const subscriptionId = message.subscriptionId ?? `alp:${message.requestId}`;
      const subscription: Subscription = { client, subscriptionId, cwd: message.cwd, compare: message.compare };
      subscriptions.set(subscriptionId, subscription);
      schedule();
      const payload = await payloadOf(subscription);
      subscription.last = JSON.stringify(payload);
      return { type: 'subscribe_checkout_diff_response', payload: { ...payload, requestId: message.requestId } } satisfies Outbound;
    },

    unsubscribe_checkout_diff_request(message: Inbound<'unsubscribe_checkout_diff_request'>) {
      subscriptions.delete(message.subscriptionId);
    },

    async 'checkout.refresh.request'(message: Inbound<'checkout.refresh.request'>) {
      try {
        await poll(message.cwd);
        return { type: 'checkout.refresh.response', payload: { cwd: message.cwd, success: true, error: null, requestId: message.requestId } } satisfies Outbound;
      } catch (error: any) {
        return { type: 'checkout.refresh.response', payload: { cwd: message.cwd, success: false, error: { code: 'UNKNOWN', message: error?.message ?? String(error) }, requestId: message.requestId } } satisfies Outbound;
      }
    },

    checkout_pr_status_request: (message: Inbound<'checkout_pr_status_request'>) => ({
      type: 'checkout_pr_status_response',
      // No forge in ALP yet: "no remote" keeps the panel from asking the user to sign in to GitHub.
      payload: { requestId: message.requestId, cwd: message.cwd, status: null, githubFeaturesEnabled: false, authState: 'no_remote', forge: 'github', error: null },
    }) satisfies Outbound,
  };

  return {
    handlers,
    features: { checkoutRefresh: true },
    /** A client left: its subscriptions go. */
    drop(client: ClientContext) {
      for (const [id, subscription] of subscriptions) if (subscription.client === client) subscriptions.delete(id);
      if (!subscriptions.size && timer) { clearInterval(timer); timer = undefined; }
    },
    close() { if (timer) clearInterval(timer); timer = undefined; },
  };
}
