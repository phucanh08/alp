import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, realpath, stat, chmod, unlink } from 'node:fs/promises';
import path from 'node:path';

export type ProjectRecord = { id: string; root: string; canonical?: string; customName?: string | null; addedAt: string; removedAt?: string | null };
export type WorkspaceRecord = { id: string; projectId: string; directory: string; canonical?: string; title?: string | null; pinnedAt?: string | null; labels: string[]; createdAt: string; archivedAt?: string | null; idempotencyKey?: string; worktree?: ManagedWorktree };
export type ManagedWorktree = { kind: 'user'; sourceWorkspaceId: string; source: string; commonDir: string; gitDir: string; mappingId: string; principalId: string; grantEpoch: string; requestId?: string; ifRevision?: number; branch: string; head: string; removedAt?: string };
export type Registry = { version: 1; revision: number; projects: ProjectRecord[]; workspaces: WorkspaceRecord[]; sessions: Record<string, string>; labels: { generation: string; seq: number; catalog: { name: string; color: string }[] }; worktreeJournal?: Record<string, { fingerprint: string; intent: any }>; receipts: Record<string, { fingerprint: string; result: unknown }> };
export class RegistryError extends Error {
  constructor(readonly code: number, message: string, readonly data: { reason: string }) { super(message); }
}
function fail(reason: string, message: string, code = 1004): never { throw new RegistryError(code, message, { reason }); }
const hex = () => randomBytes(8).toString('hex');
const now = () => new Date().toISOString();
const object = (v: any) => v && typeof v === 'object' && !Array.isArray(v);
const nullable = (v: any) => v === undefined || v === null || typeof v === 'string';
// Legacy bridge wire palette; domain code does not depend on the Paseo SDK.
const labelColors = new Set(['violet', 'sky', 'emerald', 'orange', 'pink', 'indigo', 'teal', 'red', 'amber', 'blue']);
const strings = (v: any) => Array.isArray(v) && v.every((s: any) => typeof s === 'string');
function validate(value: any): asserts value is Registry {
  if (!object(value) || !Array.isArray(value.projects) || !Array.isArray(value.workspaces) || !object(value.sessions) || !object(value.labels)
    || typeof value.labels.generation !== 'string' || !Number.isSafeInteger(value.labels.seq) || value.labels.seq < 0 || !Array.isArray(value.labels.catalog)
    || value.labels.catalog.some((l: any) => !object(l) || typeof l.name !== 'string' || !labelColors.has(l.color))
    || (value.version !== undefined && value.version !== 1) || (value.revision !== undefined && (!Number.isSafeInteger(value.revision) || value.revision < 0))) fail('corrupt_registry', 'Invalid workspace registry', 1005);
  if (value.version === 1 && (!Number.isSafeInteger(value.revision) || !object(value.receipts))) fail('corrupt_registry', 'Missing versioned registry metadata', 1005);
  if (value.worktreeJournal !== undefined && (!object(value.worktreeJournal) || Object.values(value.worktreeJournal).some((j: any) => !object(j) || typeof j.fingerprint !== 'string' || !object(j.intent)))) fail('corrupt_registry', 'Invalid worktree journal', 1005);
  for (const j of Object.values(value.worktreeJournal ?? {}) as any[]) { const i=j.intent; if (!['create','remove'].includes(i.method) || !/^wks_[0-9a-f]{16}$/.test(i.id) || i.branch !== `alp/workspace/${i.id}` || !['directory','source','commonDir'].every(k=>typeof i[k]==='string' && path.isAbsolute(i[k])) || !/^[0-9a-f]{40,64}$/.test(i.head)) fail('corrupt_registry','Invalid native intent',1005); }
  const projects = new Set<string>(); const workspaces = new Set<string>();
  for (const p of value.projects) {
    if (!object(p) || typeof p.id !== 'string' || !p.id || projects.has(p.id) || typeof p.root !== 'string' || !path.isAbsolute(p.root) || typeof p.addedAt !== 'string' || !nullable(p.customName) || !nullable(p.removedAt) || (p.canonical !== undefined && (typeof p.canonical !== 'string' || !path.isAbsolute(p.canonical)))) fail('corrupt_registry', 'Invalid project record', 1005);
    projects.add(p.id);
  }
  for (const w of value.workspaces) {
    if (!object(w) || typeof w.id !== 'string' || !w.id || workspaces.has(w.id) || !projects.has(w.projectId) || typeof w.directory !== 'string' || !path.isAbsolute(w.directory) || typeof w.createdAt !== 'string' || ((value.version === 1 || w.labels !== undefined) && !strings(w.labels)) || !nullable(w.title) || !nullable(w.pinnedAt) || !nullable(w.archivedAt) || (w.canonical !== undefined && (typeof w.canonical !== 'string' || !path.isAbsolute(w.canonical))) || (w.idempotencyKey !== undefined && typeof w.idempotencyKey !== 'string')) fail('corrupt_registry', 'Invalid workspace record', 1005);
    if (w.worktree !== undefined && (!object(w.worktree) || w.worktree.kind !== 'user' || ['sourceWorkspaceId','source','commonDir','gitDir','mappingId','principalId','grantEpoch','branch','head'].some(k => typeof w.worktree[k] !== 'string'))) fail('corrupt_registry', 'Invalid managed worktree', 1005);
    workspaces.add(w.id);
  }
  if (Object.values(value.sessions).some(id => typeof id !== 'string' || !workspaces.has(id))) fail('corrupt_registry', 'Invalid session placement', 1005);
  if (value.receipts !== undefined && (!object(value.receipts) || Object.values(value.receipts).some((r: any) => !object(r) || typeof r.fingerprint !== 'string' || !Object.hasOwn(r, 'result')))) fail('corrupt_registry', 'Invalid operation receipts', 1005);
}
const placementOf = (r: Registry, id: string) => Object.hasOwn(r.sessions, id) ? r.sessions[id] : undefined;
const place = (r: Registry, id: string, workspaceId: string) => Object.defineProperty(r.sessions, id, { value: workspaceId, writable: true, enumerable: true, configurable: true });
async function identity(directory: string) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) fail('directory_not_found', 'An absolute existing directory is required', -32602);
  const canonical = await realpath(directory);
  if (!(await stat(canonical)).isDirectory()) fail('directory_not_found', 'An existing directory is required', -32602);
  return canonical;
}
/** Sole mutable owner. Failed writes never publish the draft or consume a requestId. */
export function createRegistry(home: string, options: { write?: typeof writeFile } = {}) {
  const file = path.join(home, 'state', 'web-workspaces.json');
  let committed: Registry | undefined;
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const result = tail.then(fn); tail = result.catch(() => {}); return result; };
  const write = options.write ?? writeFile;
  async function persist(value: Registry) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(file), 0o700);
    const temporary = `${file}.${hex()}.tmp`;
    try { await write(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temporary, file); }
    finally { await unlink(temporary).catch(() => {}); }
  }
  async function load() {
    if (committed) return;
    let text: string;
    try { text = await readFile(file, 'utf8'); }
    catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      committed = { version: 1, revision: 0, projects: [], workspaces: [], sessions: {}, labels: { generation: hex(), seq: 0, catalog: [] }, receipts: {} }; return;
    }
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { fail('corrupt_registry', 'Workspace registry is unreadable; original retained', 1005); }
    validate(parsed);
    if (parsed.version === undefined) {
      // Keep the exact original for recovery. Never replace it with a synthesized format.
      await writeFile(`${file}.legacy-v0.json`, text, { mode: 0o600, flag: 'wx' }).catch((e: any) => { if (e.code !== 'EEXIST') throw e; });
      await chmod(`${file}.legacy-v0.json`, 0o600);
      const migrated = { ...parsed, version: 1 as const, revision: 0, receipts: {}, workspaces: parsed.workspaces.map((w: WorkspaceRecord) => ({ ...w, labels: w.labels ?? [] })) };
      for (const p of migrated.projects) p.canonical = await realpath(p.root).catch(() => undefined);
      for (const w of migrated.workspaces) w.canonical = await realpath(w.directory).catch(() => undefined);
      await persist(migrated); committed = migrated;
    } else { await chmod(path.dirname(file), 0o700); await chmod(file, 0o600); committed = parsed; }
  }
  const project = (r: Registry, id: string) => r.projects.find(p => p.id === id) ?? fail('not_found', 'No project', 1001);
  const workspace = (r: Registry, id: string) => r.workspaces.find(w => w.id === id) ?? fail('not_found', 'No workspace', 1001);
  const live = (r: Registry, w: WorkspaceRecord) => !w.archivedAt && !project(r, w.projectId).removedAt;
  function register(r: Registry, directory: string, canonical?: string) {
    let p = r.projects.find(p => !p.removedAt && (p.canonical ?? path.resolve(p.root)) === (canonical ?? path.resolve(directory)));
    if (!p) { p = { id: `prj_${hex()}`, root: directory, ...(canonical === undefined ? {} : { canonical }), addedAt: now() }; r.projects.push(p); }
    return p;
  }
  function makeWorkspace(r: Registry, p: ProjectRecord, directory: string, canonical: string | undefined, fields: Partial<WorkspaceRecord> = {}) {
    const w: WorkspaceRecord = { id: `wks_${hex()}`, projectId: p.id, directory, ...(canonical === undefined ? {} : { canonical }), labels: [], createdAt: now(), ...fields }; r.workspaces.push(w); return w;
  }
  async function action(r: Registry, method: string, a: any): Promise<any> {
    switch (method) {
      case 'project.add': { const canonical = await identity(a.directory); return { project: register(r, a.directory, canonical) }; }
      case 'project.register': {
        const canonical = await identity(a.directory); const p = register(r, a.directory, canonical);
        if (!r.workspaces.some(w => w.projectId === p.id && live(r, w) && (w.canonical ?? w.directory) === canonical)) makeWorkspace(r, p, a.directory, canonical);
        return { project: p };
      }
      case 'project.remove': { const p = project(r, a.projectId); p.removedAt = now(); for (const w of r.workspaces.filter(w => w.projectId === p.id)) { w.archivedAt = now(); w.pinnedAt = null; } return { project: p }; }
      case 'project.rename': { const p = project(r, a.projectId); p.customName = a.customName?.trim() || null; return { project: p }; }
      case 'workspace.create': {
        const canonical = await identity(a.directory);
        const previous = a.idempotencyKey ? r.workspaces.find(w => w.idempotencyKey === a.idempotencyKey) : undefined;
        if (previous) { if ((previous.canonical ?? previous.directory) !== canonical) fail('request_conflict', 'Idempotency key names another directory'); return { workspace: previous }; }
        const p = a.projectId ? project(r, a.projectId) : register(r, a.directory, canonical);
        if (p.removedAt) fail('not_found', 'Project was removed', 1001);
        return { workspace: makeWorkspace(r, p, a.directory, canonical, { ...(a.workspaceId ? { id: a.workspaceId } : {}), title: a.title?.trim() || null, ...(a.idempotencyKey ? { idempotencyKey: a.idempotencyKey } : {}) }) };
      }
      case 'workspace.update': {
        const w = workspace(r, a.workspaceId);
        if (a.title !== undefined) w.title = a.title?.trim() || null;
        if (a.pinned !== undefined) w.pinnedAt = a.pinned ? w.pinnedAt ?? now() : null;
        if (a.archived !== undefined) { w.archivedAt = a.archived ? now() : null; if (a.archived) w.pinnedAt = null; }
        return { workspace: w };
      }
      case 'placement.prepare': {
        for (const s of a.sessions) {
          const mapped = placementOf(r, s.id);
          let w = mapped ? workspace(r, mapped) : undefined;
          const historical = s.archived || s.status === 'closed' || s.status === 'error';
          // Preparation projects saved roots, including history and processes whose cwd
          // was deleted. It does not authorize execution: resolve still checks live identity.
          // A saved mapping must never be rebound through a retargeted directory alias.
          if (w) {
            if (!historical && w.archivedAt) w.archivedAt = null;
            continue;
          }
          if (typeof s.projectRoot !== 'string' || !path.isAbsolute(s.projectRoot)) fail('directory_not_found', 'An absolute directory is required', -32602);
          const lexical = path.resolve(s.projectRoot);
          // A lexical fallback is placement metadata, never proof of canonical identity.
          const canonical = await identity(s.projectRoot).catch((error: any) => {
            if (historical || error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
            throw error;
          });
          const here = r.workspaces.filter(w => canonical === undefined ? path.resolve(w.directory) === lexical : (w.canonical ?? w.directory) === canonical).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          w = here.find(w => live(r, w)) ?? (s.archived ? here.at(-1) : undefined) ?? makeWorkspace(r, register(r, s.projectRoot, canonical), s.projectRoot, canonical, s.archived ? { archivedAt: s.updatedAt ?? now() } : {});
          place(r, s.id, w.id);
        }
        return {};
      }
      case 'placement.assign': { workspace(r, a.workspaceId); if (placementOf(r, a.sessionId) && placementOf(r, a.sessionId) !== a.workspaceId) fail('workspace_mismatch', 'Session already has another workspace'); place(r, a.sessionId, a.workspaceId); return {}; }
      case 'placement.remove': { if (placementOf(r, a.sessionId) === a.workspaceId) delete r.sessions[a.sessionId]; return {}; }
      case 'label.assign': {
        const w = workspace(r, a.workspaceId); const name = a.label.name.trim().replace(/\s+/g, ' '); if (!name) fail('invalid_label', 'A label needs a name', -32602);
        let l = r.labels.catalog.find(l => l.name.toLowerCase() === name.toLowerCase());
        if (!l && a.assigned) { l = { name, color: a.label.color }; r.labels.catalog.push(l); r.labels.seq++; }
        w.labels = w.labels.filter(n => n.toLowerCase() !== name.toLowerCase()); if (a.assigned && l) w.labels.push(l.name); return { label: l ?? a.label, workspaceLabels: w.labels };
      }
      case 'label.update': {
        const l = r.labels.catalog.find(l => l.name.toLowerCase() === a.name.toLowerCase()); if (!l) fail('not_found', 'No label', 1001);
        const previousName = l.name; const name = a.newName === undefined ? l.name : a.newName.trim().replace(/\s+/g, ' ');
        if (!name || r.labels.catalog.some(other => other !== l && other.name.toLowerCase() === name.toLowerCase())) fail('label_name_taken', 'Invalid or duplicate label', -32602);
        l.name = name; if (a.color) l.color = a.color;
        let affectedWorkspaceCount = 0;
        for (const w of r.workspaces) { const i = w.labels.findIndex(n => n.toLowerCase() === previousName.toLowerCase()); if (i >= 0) { w.labels[i] = name; affectedWorkspaceCount++; } }
        r.labels.seq++; return { label: l, previousName, affectedWorkspaceCount };
      }
      case 'label.delete': {
        const l = r.labels.catalog.find(l => l.name.toLowerCase() === a.name.toLowerCase()); if (!l) fail('not_found', 'No label', 1001);
        r.labels.catalog = r.labels.catalog.filter(other => other !== l); let affectedWorkspaceCount = 0;
        for (const w of r.workspaces) { const before = w.labels.length; w.labels = w.labels.filter(n => n.toLowerCase() !== l.name.toLowerCase()); if (before !== w.labels.length) affectedWorkspaceCount++; }
        r.labels.seq++; return { affectedWorkspaceCount };
      }
      default: return fail('unknown_operation', 'Unknown registry operation', -32602);
    }
  }
  const fingerprintOf = (args: any, revision: number | undefined) => createHash('sha256').update(JSON.stringify({ args, ifRevision: revision }, (_key, value) => object(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest('hex');
  return {
    /** Native intent and receipt share the sole registry writer and atomic persistence boundary. */
    nativeMutation: (method: string, args: any, context: { actor: string; requestId: string; ifRevision: number }, prepare: (r: Registry) => Promise<any>, apply: (intent: any, draft: Registry) => Promise<any>) => serial(async () => {
      await load();
      if (!context.requestId || typeof context.requestId !== 'string' || context.requestId.length > 200 || !Number.isSafeInteger(context.ifRevision) || context.ifRevision < 0) fail('invalid_request_id', 'requestId and ifRevision are required', -32602);
      const key = createHash('sha256').update(JSON.stringify([context.actor, method, context.requestId])).digest('hex');
      const fingerprint = fingerprintOf(args, context.ifRevision);
      const receipt = committed!.receipts[key];
      if (receipt) { if (receipt.fingerprint !== fingerprint) fail('request_conflict', 'requestId reused'); return structuredClone(receipt.result); }
      const pending = committed!.worktreeJournal?.[key];
      if (pending && pending.fingerprint !== fingerprint) fail('request_conflict', 'requestId reused');
      if (!pending && Object.keys(committed!.worktreeJournal ?? {}).length) fail('reconciliation_required', 'Retry the pending worktree request before another mutation');
      if (!pending && context.ifRevision !== committed!.revision) fail('stale_revision', 'Registry changed; refresh');
      if (!pending) {
        const intent = await prepare(structuredClone(committed!));
        const draft = structuredClone(committed!); (draft.worktreeJournal ??= {})[key] = { fingerprint, intent };
        await persist(draft); committed = draft;
      }
      const draft = structuredClone(committed!);
      const result = await apply(structuredClone(draft.worktreeJournal![key].intent), draft);
      draft.revision++;
      const response = { ...result, revision: draft.revision };
      draft.receipts[key] = { fingerprint, result: structuredClone(response) }; delete draft.worktreeJournal![key];
      validate(draft); await persist(draft); committed = draft; return structuredClone(response);
    }),
    snapshot: () => serial(async () => { await load(); return structuredClone(committed!); }),
    mutate: (method: string, args: any, context: { actor?: string; allowedRoots?: string[]; ifRevision?: number; requestId: string }) => serial(async () => {
      await load();
      if (Object.keys(committed!.worktreeJournal ?? {}).length) fail('reconciliation_required', 'Retry the pending worktree request before changing metadata');
      if (context.allowedRoots) {
        const checked = async (directory: string, canonical?: string) => {
          const actual = await identity(directory);
          if (!context.allowedRoots!.includes(actual) || (canonical !== undefined && canonical !== actual)) fail('outside_workspace', 'Resource is outside the credential grant', 1003);
        };
        if (method === 'project.register') await checked(args.directory);
        else if (method === 'workspace.update') { const w = workspace(committed!, args.workspaceId); await checked(w.directory, w.canonical); }
        else if (method === 'project.remove') {
          const p = project(committed!, args.projectId); await checked(p.root, p.canonical);
          for (const w of committed!.workspaces.filter(w => w.projectId === p.id)) await checked(w.directory, w.canonical);
        }
      }
      if (!context.requestId || typeof context.requestId !== 'string' || context.requestId.length > 200) fail('invalid_request_id', 'requestId is required', -32602);
      const key = createHash('sha256').update(JSON.stringify([context.actor ?? 'owner', method, context.requestId])).digest('hex');
      const fingerprint = createHash('sha256').update(JSON.stringify({ args, ifRevision: context.ifRevision }, (_key, value) => object(value) ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest('hex');
      const receipt = committed!.receipts[key];
      if (receipt) { if (receipt.fingerprint !== fingerprint) fail('request_conflict', 'requestId reused with different payload'); return structuredClone(receipt.result); }
      if (context.ifRevision !== undefined && context.ifRevision !== committed!.revision) fail('stale_revision', 'Registry changed; refresh and retry');
      const draft = structuredClone(committed!); const result = await action(draft, method, args);
      if (method === 'placement.prepare' && JSON.stringify(draft) === JSON.stringify(committed)) return { ...result, revision: draft.revision };
      draft.revision++;
      const response = { ...result, revision: draft.revision };
      draft.receipts[key] = { fingerprint, result: structuredClone(response) };
      validate(draft); await persist(draft); committed = draft;
      return structuredClone(response);
    }),
    async resolve(workspaceId: string, cwd?: string, includeArchived = false) {
      const r = await this.snapshot(); const w = workspace(r, workspaceId);
      if (!includeArchived && !live(r, w)) fail('not_found', 'Workspace is archived', 1001);
      if (Object.values(r.worktreeJournal ?? {}).some(j => j.intent.id === workspaceId)) fail('reconciliation_required', 'Workspace mutation requires reconciliation');
      const canonical = await identity(w.directory);
      if (canonical !== (w.canonical ?? w.directory)) fail('identity_changed', 'Workspace directory identity changed', 1003);
      if (cwd !== undefined && await identity(cwd) !== canonical) fail('cwd_mismatch', 'cwd and workspaceId must agree', -32602);
      return canonical;
    },
  };
}
export type RegistryService = ReturnType<typeof createRegistry>;
