import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { user_worktree } from '@anhlp/alp-core';
import { RegistryError, type RegistryService, type Registry, type WorkspaceRecord } from './registry.js';

type Mapping = { id: string; source: string; commonDir: string; parent: string };
type Context = { principalId?: string; principalEpoch?: string; mappingIds?: string[]; authorizedRoots?: string[] };
/** What the owner confirms before a legacy managed worktree is adopted (t-c1ba), each proven from Git and the filesystem. */
export type AdoptionFacts = { workspaceId: string; directory: string; source: string; commonDir: string; gitDir: string; branch: string; head: string };
const fail = (reason: string, message: string, code = 1004): never => {
  throw new RegistryError(code, message, { reason });
};
const git = user_worktree.userWorktreeGit;
/** Owner-only file; neither an RPC parameter nor repository configuration can approve a destination. */
export async function worktreeMappings(home: string): Promise<Mapping[]> {
  const file = path.join(home, 'worktree-destinations.json');
  const info = await lstat(file).catch((e: any) => {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  });
  if (!info) return [];
  if (!info.isFile() || (process.platform !== 'win32' && (info.uid !== process.getuid?.() || info.mode & 0o077)))
    fail('mapping_invalid', 'Worktree destination configuration must be private', 1005);
  const value = JSON.parse(await readFile(file, 'utf8'));
  if (value?.version !== 1 || !Array.isArray(value.mappings))
    fail('mapping_invalid', 'Invalid worktree destination configuration', 1005);
  const ids = new Set<string>();
  for (const m of value.mappings) {
    if (!m || typeof m.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(m.id) || ids.has(m.id))
      fail('mapping_invalid', 'Invalid mapping identity', 1005);
    ids.add(m.id);
    for (const k of ['source', 'commonDir', 'parent']) {
      if (
        typeof m[k] !== 'string' ||
        !path.isAbsolute(m[k]) ||
        (await realpath(m[k])) !== m[k] ||
        !(await stat(m[k])).isDirectory()
      )
        fail('mapping_invalid', 'Mapping paths must be existing canonical directories', 1005);
    }
    const parentInfo = await stat(m.parent);
    if (process.platform !== 'win32' && (parentInfo.uid !== process.getuid?.() || parentInfo.mode & 0o077))
      fail('mapping_invalid', 'Destination parent must be owner-private', 1005);
    for (const reserved of [path.join(home, 'worktrees'), path.join(home, 'copies'), m.commonDir])
      if (m.parent === reserved || m.parent.startsWith(reserved + path.sep) || reserved.startsWith(m.parent + path.sep))
        fail('mapping_invalid', 'Destination overlaps protected assignment or Git storage', 1005);
    if (m.parent === m.source || m.parent.startsWith(m.source + path.sep) || m.source.startsWith(m.parent + path.sep))
      fail('mapping_invalid', 'Destination parent must be separate from source', 1005);
  }
  return value.mappings;
}
export function createWorkspaceWorktrees(
  home: string,
  registry: RegistryService,
  guard: <T>(directory: string, run: () => Promise<T>) => Promise<T>,
  register: (directory: string) => Promise<void>,
  adoptWorkspace?: (directory: string, verify: (canonical: string) => Promise<void>) => Promise<void>
) {
  const adapter = git();
  async function approved(context: Context, source: string, mappingId: string, native = true) {
    const m = (await worktreeMappings(home)).find((m) => m.id === mappingId && m.source === source);
    if (!m) return fail('outside_workspace', 'Mapping unavailable', 1003);
    if (
      (context.mappingIds && !context.mappingIds.includes(m.id)) ||
      (context.authorizedRoots && !context.authorizedRoots.includes(source))
    )
      fail('outside_workspace', 'Worktree mapping is not approved for this credential', 1003);
    if ((await (native ? adapter.facts(source) : user_worktree.repositoryIdentity(source))).commonDir !== m.commonDir)
      fail('identity_changed', 'Source repository identity changed', 1003);
    return m;
  }
  const workspace = (r: Registry, id: string) =>
    r.workspaces.find((w) => w.id === id) ?? fail('not_found', 'No workspace', 1001);
  async function sourceOf(r: Registry, id: string) {
    const w = workspace(r, id);
    if (w.archivedAt || w.worktree?.removedAt || r.projects.find((p) => p.id === w.projectId)?.removedAt)
      fail('not_found', 'Workspace unavailable', 1001);
    if ((await realpath(w.directory)) !== (w.canonical ?? w.directory))
      fail('identity_changed', 'Source identity changed', 1003);
    return w;
  }
  /**
   * Proves what adopting a managed worktree would certify. The registry row only names what to
   * check; it is never evidence of identity, and never permission to delete.
   */
  async function adoptionFacts(r: Registry, id: string): Promise<AdoptionFacts> {
    const w = workspace(r, id);
    const meta = w.worktree;
    if (!meta || meta.kind !== 'user' || meta.removedAt || w.archivedAt)
      return fail('not_managed', 'Only a present managed user worktree can be adopted', 1003);
    if (Object.values(r.worktreeJournal ?? {}).some((j) => j.intent.id === w.id))
      fail('reconciliation_required', 'Workspace is pending reconciliation');
    // The source repository and its commonDir as the host approves them now, not as the row recorded them.
    const mapping = (await worktreeMappings(home)).find(
      (m) => m.id === meta.mappingId && m.source === meta.source && m.commonDir === meta.commonDir
    );
    if (!mapping) return fail('outside_workspace', 'The host does not approve its destination mapping now', 1003);
    const directory = path.join(mapping.parent, w.id);
    const branch = `alp/workspace/${w.id}`;
    if (!/^wks_[0-9a-f]{16}$/.test(w.id) || w.directory !== directory || (w.canonical ?? w.directory) !== directory || meta.branch !== branch)
      fail('identity_changed', 'Not a generated managed worktree', 1003);
    // No symlink anywhere on the path: it is a real directory whose canonical path is itself.
    const info = await lstat(directory).catch(() => undefined);
    if (!info?.isDirectory() || (await realpath(directory).catch(() => undefined)) !== directory)
      fail('identity_changed', 'Managed worktree path is missing or not canonical', 1003);
    const origin = await adapter.facts(mapping.source).catch(() => undefined);
    if (origin?.commonDir !== mapping.commonDir) fail('identity_changed', 'Source repository identity changed', 1003);
    // Git lists it as a linked worktree of that repository on its own branch, neither locked nor prunable.
    const row = await adapter.inspect(mapping.source, directory, branch).catch(() => undefined);
    const target = row ? await adapter.facts(directory).catch(() => undefined) : undefined;
    if (
      !row ||
      !target ||
      target.commonDir !== mapping.commonDir ||
      target.gitDir === target.commonDir ||
      target.gitDir !== meta.gitDir ||
      target.branch !== branch ||
      row.HEAD !== target.head
    )
      return fail('identity_changed', 'Git does not list it as this managed worktree', 1003);
    return { workspaceId: w.id, directory, source: mapping.source, commonDir: mapping.commonDir, gitDir: target.gitDir, branch, head: target.head };
  }
  const owner = (context: Context) => {
    if ((context.principalId ?? 'owner') !== 'owner' || (context.principalEpoch ?? 'owner') !== 'owner' || context.mappingIds || context.authorizedRoots)
      fail('owner_only', 'Only the host owner adopts a workspace', 1003);
  };
  /** Owner-private append-only record of every adoption request and its outcome. */
  async function audit(entry: Record<string, unknown>) {
    const file = path.join(home, 'state', 'workspace-adoptions.jsonl');
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const handle = await open(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
    } finally {
      await handle.close();
    }
  }
  async function clean(source: string, target: string, branch: string, head: string) {
    if (!(await adapter.inspect(source, target, branch)))
      fail('outcome_unknown', 'Worktree creation needs owner reconciliation', 1005);
    // Reconciliation never resets files: a partially materialized or subsequently edited checkout is retained.
    if ((await adapter.facts(target)).head !== head) fail('outcome_unknown', 'Prepared worktree HEAD changed', 1005);
    await adapter.assertClean(target);
  }
  return {
    async describe(w: WorkspaceRecord) {
      const { worktree, ...row } = w;
      let branch: string | null = null;
      try {
        // The registry keeps the directory as given (it may pass through a symlink, e.g. /var on
        // macOS) and its realpath as canonical; read the checkout only where that identity still
        // holds. A record with no canonical identity is read only at its own, already canonical, path.
        const canonical = await realpath(w.directory);
        if (canonical === (w.canonical ?? w.directory))
          branch = (await user_worktree.repositoryIdentity(canonical)).branch;
      } catch {}
      return { ...row, branch, ...(worktree ? { managedWorktree: true } : {}) };
    },
    /** What adopting this legacy managed worktree would certify (t-c1ba); it changes nothing. */
    async adoption(workspaceId: string, context: Context = {}) {
      owner(context);
      return adoptionFacts(await registry.snapshot(), workspaceId);
    },
    /**
     * Certifies a managed worktree that predates birth certification, once the owner confirmed the
     * facts `adoption` showed. The facts are proven again under the runtime's removal guard, which
     * also refuses any checkout an assignment, claim, lease or session still owns. Removal stays a
     * separate request with all of its own checks.
     */
    async adopt(p: { workspaceId: string; confirm: AdoptionFacts }, context: Context = {}) {
      owner(context);
      if (!adoptWorkspace) return fail('guard_unavailable', 'Runtime cannot prove safe adoption', 1005);
      const confirmed = (facts: AdoptionFacts) =>
        !!p.confirm &&
        typeof p.confirm === 'object' &&
        Object.keys(p.confirm).length === Object.keys(facts).length &&
        (Object.keys(facts) as (keyof AdoptionFacts)[]).every((k) => p.confirm[k] === facts[k]);
      const facts = await adoptionFacts(await registry.snapshot(), p.workspaceId);
      if (!confirmed(facts)) fail('confirmation_mismatch', 'The workspace differs from what was confirmed; review it and confirm again', 1003);
      // Logged before certification: no adoption happens unrecorded.
      await audit({ event: 'adoption.requested', actor: 'owner', ...facts });
      try {
        await adoptWorkspace(facts.directory, async () => {
          if (!confirmed(await adoptionFacts(await registry.snapshot(), p.workspaceId)))
            fail('confirmation_mismatch', 'The workspace changed after it was confirmed; review it and confirm again', 1003);
        });
      } catch (error: any) {
        await audit({ event: 'adoption.refused', actor: 'owner', workspaceId: facts.workspaceId, reason: error?.data?.reason ?? 'failed', error: error?.message ?? String(error) }).catch(() => {});
        throw error;
      }
      await audit({ event: 'adoption.certified', actor: 'owner', workspaceId: facts.workspaceId, directory: facts.directory });
      return { adopted: facts };
    },
    async assertAvailable(directory: string) {
      const r = await registry.snapshot();
      const canonical = await realpath(directory).catch(() => path.resolve(directory));
      if (
        Object.values(r.worktreeJournal ?? {}).some(
          (j) => canonical === j.intent.directory || canonical.startsWith(j.intent.directory + path.sep)
        )
      )
        fail('reconciliation_required', 'Workspace is pending reconciliation');
    },
    async grants(context: Context = {}) {
      const r = await registry.snapshot();
      const mappings: Mapping[] = [];
      for (const m of await worktreeMappings(home)) {
        try {
          await approved(context, m.source, m.id, false);
          mappings.push(m);
        } catch {}
      }
      const workspaces: WorkspaceRecord[] = [];
      for (const w of r.workspaces) {
        const m = w.worktree;
        if (
          !m ||
          m.principalId !== (context.principalId ?? 'owner') ||
          m.grantEpoch !== (context.principalEpoch ?? 'owner') ||
          !mappings.some((a) => a.id === m.mappingId && a.source === m.source && a.commonDir === m.commonDir)
        )
          continue;
        const expected = path.join(mappings.find((a) => a.id === m.mappingId)!.parent, w.id);
        if (w.directory !== expected || w.canonical !== expected) continue;
        const pending = Object.values(r.worktreeJournal ?? {}).find((j) => j.intent.id === w.id);
        if (!m.removedAt && !pending) {
          try {
            const identity = await user_worktree.repositoryIdentity(w.directory);
            if (
              identity.gitDir !== m.gitDir ||
              identity.commonDir !== m.commonDir ||
              identity.branch !== m.branch ||
              (await lstat(path.join(identity.gitDir, 'locked')).catch((e: any) => {
                if (e.code === 'ENOENT') return undefined;
                throw e;
              }))
            )
              continue;
          } catch {
            continue;
          }
        }
        workspaces.push(
          Object.values(r.worktreeJournal ?? {}).some((j) => j.intent.id === w.id)
            ? { ...w, archivedAt: w.archivedAt ?? 'pending' }
            : w
        );
      }
      return { mappings: mappings.map((m) => ({ id: m.id, source: m.source })), workspaces };
    },
    async mutate(method: 'create' | 'remove', p: any, context: Context = {}) {
      const actor = context.principalId ?? 'owner';
      const r = await registry.snapshot();
      const w = workspace(r, p.workspaceId);
      const origin = method === 'create' ? await sourceOf(r, w.id) : w;
      const meta = w.worktree;
      if (
        method === 'remove' &&
        (!meta ||
          meta.kind !== 'user' ||
          meta.principalId !== actor ||
          meta.grantEpoch !== (context.principalEpoch ?? 'owner'))
      )
        fail('not_managed', 'Only your managed user worktrees can be removed', 1003);
      const source = method === 'create' ? await realpath(origin.directory) : meta!.source;
      const mappingId = method === 'create' ? p.mappingId : meta!.mappingId;
      const mapping = await approved(context, source, mappingId);
      return registry.nativeMutation(
        'workspace.worktree.' + method,
        { workspaceId: p.workspaceId, ...(method === 'create' ? { mappingId: p.mappingId } : {}) },
        { actor: actor + ':' + (context.principalEpoch ?? 'owner'), requestId: p.requestId, ifRevision: p.ifRevision },
        async (draft) => {
          if (method === 'create') {
            const id = 'wks_' + randomBytes(8).toString('hex');
            const facts = await adapter.facts(source);
            return {
              method,
              id,
              requestId: p.requestId,
              ifRevision: p.ifRevision,
              directory: path.join(mapping.parent, id),
              projectId: origin.projectId,
              sourceWorkspaceId: origin.id,
              source,
              commonDir: mapping.commonDir,
              mappingId,
              principalId: actor,
              grantEpoch: context.principalEpoch ?? 'owner',
              branch: `alp/workspace/${id}`,
              head: facts.head
            };
          }
          if (w.directory !== path.join(mapping.parent, w.id) || w.canonical !== w.directory)
            fail('identity_changed', 'Managed worktree path changed', 1003);
          // Guard before journaling so ordinary safety refusals do not strand a prepared intent.
          await guard(w.directory, async () => {
            if (Object.values(draft.sessions).includes(w.id))
              fail(
                'workspace_history',
                'Saved sessions reference this checkout; retain its files. This operation does not delete history.'
              );
            try {
              await adapter.assertClean(w.directory);
            } catch {
              fail(
                'workspace_dirty',
                'Worktree has dirty, ignored, hidden-index or submodule data; preserve it before removal'
              );
            }
          });
          return { method, id: w.id, directory: w.directory, ...meta };
        },
        async (intent, draft) => {
          await approved(context, intent.source, intent.mappingId);
          if (
            intent.principalId !== actor ||
            intent.grantEpoch !== (context.principalEpoch ?? 'owner') ||
            intent.directory !== path.join(mapping.parent, intent.id) ||
            intent.commonDir !== mapping.commonDir
          )
            fail('identity_changed', 'Worktree journal identity changed', 1003);
          if (method === 'create') {
            const row = await adapter.inspect(intent.source, intent.directory, intent.branch);
            if (!row) await adapter.create(intent.source, mapping.parent, intent.id, intent.branch, intent.head);
            await clean(intent.source, intent.directory, intent.branch, intent.head);
            await register(intent.directory);
            const created: WorkspaceRecord = {
              id: intent.id,
              projectId: intent.projectId,
              directory: intent.directory,
              canonical: intent.directory,
              labels: [],
              createdAt: new Date().toISOString(),
              worktree: {
                kind: 'user',
                sourceWorkspaceId: intent.sourceWorkspaceId,
                source: intent.source,
                commonDir: intent.commonDir,
                gitDir: (await user_worktree.repositoryIdentity(intent.directory)).gitDir,
                requestId: intent.requestId,
                ifRevision: intent.ifRevision,
                mappingId: intent.mappingId,
                principalId: actor,
                grantEpoch: context.principalEpoch ?? 'owner',
                branch: intent.branch,
                head: intent.head
              }
            };
            draft.workspaces.push(created);
            return { workspace: created };
          }
          const finish = async () => {
            if (Object.values(draft.sessions).includes(intent.id))
              fail(
                'workspace_history',
                'Saved sessions reference this checkout; retain its files. This operation does not delete history.'
              );
            const present = await lstat(intent.directory).catch((e: any) => {
              if (e.code === 'ENOENT') return undefined;
              throw e;
            });
            if (present) await adapter.remove(intent.source, intent.directory, intent.branch);
            else if (await adapter.inspect(intent.source, intent.directory, intent.branch))
              fail('outcome_unknown', 'Worktree removal needs reconciliation', 1005);
            const removed = workspace(draft, intent.id);
            removed.archivedAt = new Date().toISOString();
            removed.pinnedAt = null;
            removed.worktree!.removedAt = removed.archivedAt;
            return { workspace: removed, filesRemoved: true, branchRetained: true };
          };
          const present = await lstat(intent.directory).catch((e: any) => {
            if (e.code === 'ENOENT') return undefined;
            throw e;
          });
          return present ? guard(intent.directory, finish) : finish();
        }
      );
    }
  };
}
