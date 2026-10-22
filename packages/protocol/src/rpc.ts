/** Portable JSON-RPC structures; implementations and provider SDKs stay outside protocol. */
import type { RuntimeKind, Pin } from './dto.js';
import type { AlpError, Envelope, SessionSnapshot, TreeStatus, TurnAttention, UserQuestion } from './events.js';
import type { PauseState, PromptContent, RecallAnswer, SessionPreview, SessionSpec, SessionSummary } from './session.js';
import type { EntryName, LanguageSetting, LibraryEntryRow, LibraryKind, LibraryScope, LibrarySource, TaskRow, TeamRow } from './dto.js';
import type { ScheduleJob, ScheduleStatus } from './schedule.js';

export type RpcId = string | number | null;
export type RpcErrorData = { code: number; message: string; data?: unknown };
export type RpcRequest = { jsonrpc: '2.0'; id?: RpcId; method: string; params?: Record<string, unknown> };
export type RpcResponse = { jsonrpc: '2.0'; id: RpcId } & ({ result: unknown; error?: never } | { error: RpcErrorData; result?: never });
export type EventNotification = { jsonrpc: '2.0'; method: 'event'; params: Envelope };

/** Names a daemon may list in its daemon.hello result (schema/methods-v1.json `capabilities`). */
export type HistoryItem = Envelope | { cursor: number; oversized: { bytes: number } };
export type HistoryPage = { generation: string; items: HistoryItem[]; olderCursor?: string; hasOlder: boolean; tipCursor: number };

export type Capability = 'attachments' | 'workspace.git' | 'workspace.worktree' | 'workspace.registry' | 'session.history' | 'attach.after' | 'prompt.receipts' | 'extension.methods' | 'team' | 'task' | 'library' | 'library.project.write' | 'settings.language' | 'session.list.page' | 'question.watch' | 'question.watch.turns' | 'session.attention' | 'workspace.files' | 'workspace.files.read' | 'prompt.images' | 'schedule';

/** `data.reason` values alpd sets on errors (docs/protocol/alp-json-rpc-v1.md §5.3). */
export type ErrorReason =
  | 'hello_required' | 'protocol_version' | 'invalid_params' | 'invalid_id' | 'batch_unsupported' | 'frame_too_large'
  | 'invalid_cursor' | 'stale_cursor' | 'history_gap'
  | 'stale_revision' | 'request_conflict' | 'cwd_mismatch' | 'workspace_mismatch' | 'corrupt_registry' | 'identity_changed'
  | 'response_too_large' | 'persistence_failed' | 'outcome_unknown' | 'key_conflict'
  // Project, task and library methods (docs/protocol/alp-json-rpc-v1.md §5.3).
  | 'invalid_path' | 'invalid_scope' | 'invalid_entry' | 'secret_marker' | 'not_alp_project' | 'unknown_task' | 'not_found'
  | 'library_policy' | 'unsafe_path' | 'revision_conflict' | 'task_state' | 'in_use' | 'busy' | 'unreadable'
  // workspace.files.search (§12.3); workspace.files.list and read (§12.4).
  | 'not_directory' | 'blocked_path' | 'ignored' | 'linked' | 'binary' | 'too_large'
  // workspace.git.status and workspace.git.diff (§12.5).
  | 'not_repository' | 'unknown_ref' | 'invalid_compare' | 'stale_snapshot' | 'git_unavailable' | 'git_failed'
  // Attachments (§12.6).
  | 'invalid_name' | 'invalid_data' | 'attachment_too_large' | 'offset_mismatch' | 'chunk_conflict' | 'upload_incomplete'
  | 'hash_mismatch' | 'upload_expired' | 'quota_exceeded' | 'attachment_referenced' | 'attachment_limit'
  | 'attachment_unavailable' | 'attachment_unsupported';

type Empty = Record<string, never>;

/**
 * Params and result of every v1 method, as schema/methods-v1.json defines them; the protocol tests
 * type-check the golden fixtures against this map, so the two cannot drift. Results may carry
 * properties this map does not name: clients ignore them.
 */
export type RegistryProject = { id: string; root: string; canonical?: string; customName?: string | null; addedAt: string; removedAt?: string | null; revision?: number };
export type RegistryWorkspace = { branch?: string | null; managedWorktree?: boolean; id: string; projectId: string; directory: string; canonical?: string; title?: string | null; pinnedAt?: string | null; archivedAt?: string | null; labels: string[]; createdAt: string; revision?: number; idempotencyKey?: string };
/** workspace.git.status and workspace.git.diff (capability `workspace.git`, §12.5): paths are relative to the workspace, never host paths. */
export type GitChange = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'untracked' | 'conflicted';
export type GitCompare = { mode: 'uncommitted' | 'staged' | 'unstaged' | 'base'; baseRef?: string; ignoreWhitespace?: boolean };
export type GitStatusFile = { path: string; oldPath?: string; change: GitChange; staged: boolean; unstaged: boolean };
export type GitStatus = {
  state: 'repository' | 'not_repository' | 'unsupported'; reason?: string;
  branch: string | null; detached: boolean; head: string | null;
  upstream: { ref: string; ahead: number; behind: number } | null;
  baseRef: string | null; aheadBehind: { ahead: number; behind: number } | null;
  hasRemote: boolean; remoteUrl: string | null; dirty: boolean;
  files: GitStatusFile[]; hiddenCount: number; truncated: boolean; snapshot: string;
};
export type GitDiffLine = { type: 'add' | 'remove' | 'context'; content: string; noNewline?: true };
export type GitDiffHunk = { oldStart: number; oldCount: number; newStart: number; newCount: number; context?: string; lines: GitDiffLine[] };
export type GitDiffFile = { path: string; oldPath?: string; change: GitChange; kind: 'text' | 'binary' | 'too_large' | 'withheld' | 'symlink' | 'submodule'; additions: number; deletions: number; hunks: GitDiffHunk[] };
export type GitDiffPage = { compare: { mode: GitCompare['mode']; baseRef?: string; ignoreWhitespace: boolean }; snapshot: string; files: GitDiffFile[]; hiddenCount: number; truncated: boolean; nextCursor?: string };
/**
 * Capability `attachments` (§12.6). Principal context is set only by a trusted gateway on its own
 * connection; a local client leaves it out and acts as the owner.
 */
export type PrincipalContext = { principalId?: string; principalEpoch?: string; authorizedRoots?: string[] };
/** A committed attachment as clients see it: ids and display metadata, never a host path or URL. */
export type AttachmentInfo = {
  attachmentId: string; sessionId: string; name: string; mimeType: string; detectedMimeType: string;
  size: number; sha256: string; createdAt: string; committedAt: string; referenced: boolean;
};
/** Effective attachment limits a daemon.hello advertises with capability `attachments`. */
export type AttachmentLimits = {
  maxObjectBytes: number; maxPerPrompt: number; maxPromptBytes: number; maxChunkBytes: number; maxActiveUploads: number;
  maxPrincipalBytes: number; maxDaemonBytes: number; uploadTimeoutMs: number; unreferencedRetentionMs: number; releasedGraceMs: number;
};
export type RegistryMutation = { requestId: string; ifRevision: number };
export type RegistryPage = { revision: number; total: number; nextCursor: string | null };
export type RpcMethodMap = {
  'attachment.begin': { params: PrincipalContext & { sessionId: string; name: string; size: number; mimeType: string; sha256?: string; requestId: string }; result: { uploadId: string; state: 'uploading' | 'committed'; received: number; size: number; maxChunkBytes: number; expiresAt?: string; attachmentId?: string } };
  'attachment.chunk': { params: PrincipalContext & { uploadId: string; offset: number; data: string }; result: { received: number; size: number } };
  'attachment.commit': { params: PrincipalContext & { uploadId: string; sha256: string }; result: { attachment: AttachmentInfo } };
  'attachment.abort': { params: PrincipalContext & { uploadId: string }; result: { aborted: true } };
  'attachment.get': { params: PrincipalContext & { attachmentId: string }; result: { attachment: AttachmentInfo } };
  'attachment.delete': { params: PrincipalContext & { attachmentId: string }; result: { deleted: true } };
  'workspace.git.status': { params: { workspaceId: string }; result: GitStatus };
  'workspace.git.diff': { params: { workspaceId: string; compare: GitCompare; path?: string; cursor?: string }; result: GitDiffPage };
  'workspace.worktree.options': { params: { workspaceId: string }; result: { mappingIds: string[] } };
  'workspace.worktree.create': { params: RegistryMutation & { workspaceId: string; mappingId: string }; result: { workspace: RegistryWorkspace; revision: number } };
  'workspace.worktree.remove': { params: RegistryMutation & { workspaceId: string }; result: { workspace: RegistryWorkspace; revision: number; filesRemoved: true; branchRetained: true } };
  'registry.worktree': { params: { principalId?: string; principalEpoch?: string; mappingIds?: string[]; authorizedRoots?: string[] }; result: { mappings: Array<{id:string;source:string}>; workspaces: unknown[] } };
  'project.list': { params: { cursor?: string; limit?: number; projectRoots?: string[] }; result: RegistryPage & { projects: RegistryProject[] } };
  'workspace.list': { params: { cursor?: string; limit?: number; projectRoots?: string[] }; result: RegistryPage & { workspaces: RegistryWorkspace[] } };
  'workspace.get': { params: { workspaceId: string }; result: { workspace: RegistryWorkspace; revision: number } };
  'project.register': { params: RegistryMutation & { directory: string }; result: { project: RegistryProject; revision: number } };
  'project.remove': { params: RegistryMutation & { projectId: string }; result: { project: RegistryProject; revision: number } };
  'workspace.update': { params: RegistryMutation & { workspaceId: string; title?: string | null; pinned?: boolean; archived?: boolean }; result: { workspace: RegistryWorkspace; revision: number } };
  'registry.owner': { params: { operation?: string; args?: Record<string, unknown>; requestId?: string; ifRevision?: number }; result: { registry: Record<string, unknown> } };

  'daemon.hello': { params: { protocolVersion: 1; client?: { name: string; version: string }; capabilities?: string[] }; result: { protocolVersion: 1; daemonVersion?: string; pid?: number; /** The daemon host's machine name (os.hostname()), a label for clients. */ hostname?: string; promptImageLimits?: { maxCount: number; maxBytes: number; maxTotalBytes: number }; attachmentLimits?: AttachmentLimits; capabilities?: string[] } };
  'daemon.status': {
    params: Empty;
    result: {
      pid: number; startedAt: string; version: string; protocolVersion: number; sessions: number; questions: number;
      previousExit?: { kind: 'clean' | 'crash'; at?: string };
      persistence?: Record<string, unknown>;
      health: { live: boolean; ready: boolean; checks: Array<{ id: string; ok: boolean; code?: string; message?: string }> };
    };
  };
  'daemon.shutdown': { params: Empty; result: Empty };
  'daemon.pause': { params: { runtime?: RuntimeKind; now?: boolean; reason?: string }; result: PauseState };
  'daemon.resume': { params: { runtime?: RuntimeKind }; result: PauseState };
  'daemon.pauses': { params: Empty; result: PauseState };
  'daemon.usage': { params: { refresh?: boolean }; result: { providers: Array<Record<string, unknown>> } };
  'catalog.get': { params: Empty; result: { models: Array<Record<string, unknown>>; modes: Array<Record<string, unknown>>; thinkingOptions?: unknown; defaultModel: string } };
  'assignment.recall': { params: { assignmentId?: string; taskId?: string; projectRoot?: string; question: string }; result: RecallAnswer };
  'board.list': { params: { projectRoot: string }; result: { pins: Pin[] } };
  'question.list': { params: { projectRoot?: string }; result: { questions: UserQuestion[] } };
  /** Capability `question.watch`: the waiting questions now; then this connection is told of every tree's `question` and `question.resolved` (of `projectRoot` when given). `turns` (capability `question.watch.turns`): also every root's `turn.ended`. `attention` (capability `session.attention`): also each root's attention, now and as it changes. */
  'question.watch': { params: { projectRoot?: string; turns?: boolean; attention?: boolean }; result: { questions: UserQuestion[]; attention?: Array<{ sessionId: string; attention: TurnAttention }> } };
  /** Capability `session.attention`: acknowledges a root's attention for every client; with `at`, only that one (a later turn's stays). */
  'session.attention.clear': { params: { sessionId: string; at?: string }; result: { cleared: boolean } };
  /** Capability `workspace.files`: files under `projectRoot` whose relative path matches `query`, best first; read-only, links not followed. */
  'workspace.files.search': { params: { projectRoot: string; query?: string; limit?: number }; result: { files: Array<{ path: string }>; truncated?: boolean } };
  /** Capability `workspace.files.read`: the entries of a directory under `projectRoot` (its root when `path` is left out); links, blocked and (unless `includeIgnored`) .gitignore'd entries left out. */
  'workspace.files.list': { params: { projectRoot: string; path?: string; includeIgnored?: boolean }; result: { entries: Array<{ name: string; path: string; kind: 'file' | 'directory'; size?: number; modifiedAt?: string }>; truncated?: boolean } };
  /** Capability `workspace.files.read`: a UTF-8 text file under `projectRoot`, at most 1 MiB; read-only, links not followed. */
  'workspace.files.read': { params: { projectRoot: string; path: string; includeIgnored?: boolean }; result: { path: string; content: string; size: number; modifiedAt?: string } };
  'question.answer': { params: { questionId: string; text?: string; dismiss?: boolean; reason?: string }; result: { questionId: string } };
  'session.create': {
    params: { sessionId?: string; history?: 'skip' | 'replay'; delegation?: boolean; resume?: boolean } & ({ workspaceId: string; spec: Omit<SessionSpec, 'cwd'> & { cwd?: string } } | { workspaceId?: undefined; spec: SessionSpec });
    result: { session: SessionSnapshot; attached: boolean; resumed?: true; durable?: boolean };
  };
  'session.preview': { params: { spec: SessionSpec }; result: { preview: SessionPreview } };
  'session.history': { params: { sessionId: string; before?: string; limit?: number; maxBytes?: number }; result: HistoryPage };
  'session.attach': { params: { sessionId: string; replay?: boolean; after?: number; generation?: string }; result: { session: SessionSummary; cursor: number; reset?: true } };
  'session.release': { params: { sessionId: string }; result: { closed: boolean } };
  'session.prompt': {
    params: PrincipalContext & { sessionId: string; clientMessageId: string; delivery?: 'auto' | 'steer'; content: PromptContent };
    /** `{}` from a daemon without prompt.receipts. */
    result: { outcome?: 'accepted' | 'failed'; error?: AlpError; duplicate?: boolean; durable?: boolean };
  };
  'session.interrupt': { params: { sessionId: string }; result: Empty };
  'session.configure': { params: { sessionId: string; mode?: string }; result: { session: SessionSnapshot } };
  'session.close': { params: { sessionId: string }; result: Empty };
  'session.rename': { params: { sessionId: string; title: string }; result: { session: SessionSummary } };
  'session.archive': { params: { sessionId: string; archived?: boolean }; result: { session: SessionSummary } };
  'session.get': { params: { sessionId: string }; result: { session: SessionSummary } };
  /** `limit`, `cursor`, `query` and `projectRoots` with capability `session.list.page`: a page, and `nextCursor` while more follow. */
  'session.list': { params: { projectRoot?: string; projectRoots?: string[]; rootsOnly?: boolean; includeClosed?: boolean; includeArchived?: boolean; limit?: number; cursor?: string; query?: string }; result: { sessions: SessionSummary[]; nextCursor?: string } };
  'session.status': { params: { sessionId: string }; result: { status: TreeStatus } };
  'session.message': { params: { sessionId: string; text: string }; result: Empty };
  'session.log': { params: { sessionId: string }; result: { rootId: string; entries: Array<Record<string, unknown>> } };
  'extension.register': { params: { method: string }; result: { registered: string } };
  'extension.unregister': { params: { method: string }; result: { unregistered: string } };
  'team.list': { params: { projectRoot?: string }; result: { projectRoot: string | null; teams: TeamRow[] } };
  'task.list': { params: { projectRoot: string }; result: { projectRoot: string; tasks: TaskRow[]; unreadable: Array<{ file: string; error: string }>; revision: string } };
  'task.create': { params: { projectRoot: string; title: string; priority?: number; requestId?: string }; result: { id: string; duplicate?: true } };
  'task.update': { params: { projectRoot: string; id: string; action: 'close' | 'reopen'; note?: string; ifRev?: number }; result: { id: string; status: string; rev: number; landed?: string } };
  'task.gate.resolve': { params: { projectRoot: string; id: string; gate: string; note?: string; ifRev?: number }; result: { id: string; status: string; rev: number } };
  'library.list': { params: { kind: LibraryKind; projectRoot?: string }; result: { projectRoot: string | null; entries: LibraryEntryRow[] } };
  'library.get': {
    params: { kind: LibraryKind; name: EntryName; projectRoot?: string; scope?: LibraryScope };
    /** `content` carries `{ $secret: 'keep' }` in place of each secret value; `secrets` lists their JSON Pointers. */
    result: { kind: LibraryKind; name: string; source: LibrarySource; overrides?: LibrarySource; content: Record<string, unknown>; revision: string | null; usedBy: string[]; librarySkills?: string[]; secrets?: string[] };
  };
  'library.save': {
    params: { kind: LibraryKind; name: EntryName; scope: LibraryScope; projectRoot?: string; policy?: 'project-data'; content: Record<string, unknown>; revision?: string | null; sync?: 'none' | 'known-projects' };
    result: { revision: string | null; syncedProjects?: number; syncErrors?: string[] };
  };
  'library.delete': { params: { kind: LibraryKind; name: EntryName; scope: LibraryScope; projectRoot?: string; policy?: 'project-data'; revision?: string }; result: { removed: true; now?: 'builtin' | 'library' } };
  'library.duplicate': { params: { kind: LibraryKind; from: EntryName; to: EntryName; scope: LibraryScope; projectRoot?: string; policy?: 'project-data' }; result: { revision: string | null } };
  'library.rename': { params: { kind: LibraryKind; from: EntryName; to: EntryName; scope: LibraryScope; projectRoot?: string; policy?: 'project-data' }; result: { revision: string | null } };
  'library.skills.set': { params: { agent: EntryName; skills: EntryName[] }; result: { skills: string[] } };
  'library.models': { params: Empty; result: { models: Array<{ id: string; label: string; efforts: string[]; effort?: string }> } };
  'settings.language.get': { params: Empty; result: LanguageSetting };
  'settings.language.set': { params: { language: string | null }; result: LanguageSetting };
  /** Capability `schedule`: a one-shot continuation of a root session, due at `dueAt` (UTC, ISO 8601). */
  'schedule.create': { params: { projectRoot: string; sessionId: string; dueAt: string; prompt: string }; result: { job: ScheduleJob } };
  'schedule.list': { params: { projectRoot: string; status?: ScheduleStatus }; result: { jobs: ScheduleJob[] } };
  'schedule.get': { params: { id: string; projectRoot: string }; result: { job: ScheduleJob } };
  'schedule.cancel': { params: { id: string; projectRoot: string }; result: { job: ScheduleJob } };
};

export type RpcMethod = keyof RpcMethodMap;
export type RpcParams<M extends RpcMethod> = RpcMethodMap[M]['params'];
export type RpcResult<M extends RpcMethod> = RpcMethodMap[M]['result'];
