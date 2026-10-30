/** Portable JSON-RPC structures; implementations and provider SDKs stay outside protocol. */
import type { RuntimeKind, Pin } from './dto.js';
import type { AlpError, Envelope, SessionSnapshot, TreeStatus, TurnAttention, UserQuestion } from './events.js';
import type { ConfigureOutcome, ConfigurePreview, ConversationBranch, ForkProvenance, PauseState, PromptContent, RecallAnswer, ResumeCommand, SessionPreview, SessionSpec, SessionSummary } from './session.js';
import type { EntryName, LanguageSetting, LibraryEntryRow, LibraryKind, LibraryScope, LibrarySource, TaskRow, TeamRow } from './dto.js';
import type { ScheduleJob, ScheduleStatus } from './schedule.js';

export type RpcId = string | number | null;
export type RpcErrorData = { code: number; message: string; data?: unknown };
export type RpcRequest = { jsonrpc: '2.0'; id?: RpcId; method: string; params?: Record<string, unknown> };
export type RpcResponse = { jsonrpc: '2.0'; id: RpcId } & ({ result: unknown; error?: never } | { error: RpcErrorData; result?: never });
export type EventNotification = { jsonrpc: '2.0'; method: 'event'; params: Envelope };
/** Why a terminal ended (§12.10). */
export type TerminalEndReason = 'exited' | 'closed' | 'idle' | 'lifetime' | 'detached' | 'revoked' | 'disabled' | 'shutdown';
/** A terminal as clients see it (capability `terminal`, §12.10): never a process id, shell path or host path. */
export type TerminalInfo = {
  terminalId: string; workspaceId: string; title: string; cols: number; rows: number; state: 'running' | 'exited';
  attached: boolean; createdAt: string; lastActivityAt: string; expiresAt: string;
  exitCode?: number | null; signal?: number | null; endReason?: TerminalEndReason;
  /** Absent: full native protection. root-only: best-effort Linux. none: Windows ConPTY, best-effort cleanup. */
  protection?: 'root-only' | 'none';
};
/** Effective terminal limits a daemon.hello advertises with capability `terminal`. */
export type TerminalLimits = {
  maxPerPrincipal: number; maxPerDaemon: number; maxInputBytes: number; maxOutputFrameBytes: number;
  replayBytes: number; idleMs: number; maxLifetimeMs: number; reconnectMs: number;
};
/** params of a terminal.event notification, sent only to the connection attached to the terminal. */
export type TerminalEvent =
  | { terminalId: string; type: 'output'; seq: number; data: string }
  | { terminalId: string; type: 'exit'; seq: number; exitCode: number | null; signal: number | null; reason: TerminalEndReason }
  | { terminalId: string; type: 'detached'; reason: 'replaced' | 'slow_consumer' };
export type CatalogUpdatedNotification = { jsonrpc: '2.0'; method: 'catalog.updated'; params: { fetchedAt?: string } };
export type TerminalChangedNotification = { jsonrpc: '2.0'; method: 'terminal.changed'; params: { watchId: string; cursor: string } };
export type TerminalNotification = { jsonrpc: '2.0'; method: 'terminal.event'; params: TerminalEvent };

/** Names a daemon may list in its daemon.hello result (schema/methods-v1.json `capabilities`). */
export type HistoryItem = Envelope | { cursor: number; oversized: { bytes: number } };
export type HistoryPage = { generation: string; items: HistoryItem[]; olderCursor?: string; hasOlder: boolean; tipCursor: number };

export type Capability = 'session.interrupt.turn' | 'session.fork' | 'session.rewind' | 'session.reload' | 'session.resumeCommand' | 'session.configure.live' | 'terminal' | 'terminal.capture' | 'terminal.watch' | 'attachments' | 'workspace.git' | 'workspace.worktree' | 'workspace.registry' | 'session.history' | 'attach.after' | 'prompt.receipts' | 'extension.methods' | 'team' | 'task' | 'library' | 'library.project.write' | 'settings.language' | 'session.list.page' | 'question.watch' | 'question.watch.turns' | 'session.attention' | 'workspace.files' | 'workspace.files.read' | 'workspace.files.browse' | 'host.directories' | 'prompt.images' | 'schedule' | 'catalog.live';

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
  // workspace.files.find, workspace.files.preview and internal links (§12.11).
  | 'outside' | 'changed'
  // workspace.git.status and workspace.git.diff (§12.5).
  | 'not_repository' | 'unknown_ref' | 'invalid_compare' | 'stale_snapshot' | 'git_unavailable' | 'git_failed'
  // Attachments (§12.6).
  | 'invalid_name' | 'invalid_data' | 'attachment_too_large' | 'offset_mismatch' | 'chunk_conflict' | 'upload_incomplete'
  | 'hash_mismatch' | 'upload_expired' | 'quota_exceeded' | 'attachment_referenced' | 'attachment_limit'
  | 'attachment_unavailable' | 'attachment_unsupported'
  // session.fork and session.rewind (§12.7).
  | 'session_busy' | 'stale_generation' | 'turn_not_found' | 'turn_in_progress' | 'empty_prefix' | 'boundary_unmapped'
  | 'runtime_unsupported' | 'native_refused' | 'branch_not_found' | 'attachment_forbidden'
  // session.reload (§12.8).
  | 'session_closed' | 'no_history'
  // session.configure with model, thinking or team (§12.9).
  | 'runtime_mismatch' | 'agent_mismatch' | 'permission_escalation' | 'team_not_found'
  // Terminal (§12.10).
  | 'terminal_capture_unavailable' | 'terminal_capture_too_large' | 'terminal_snapshot_too_large'
  | 'terminal_disabled' | 'terminal_unsupported' | 'terminal_limit' | 'not_attached' | 'terminal_exited' | 'input_too_large';

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
/** Where a fork cuts the source conversation (§12.7): after a completed turn, or before a turn. */
export type ForkBoundary = { throughTurnId: string } | { beforeTurnId: string };
export type RegistryMutation = { requestId: string; ifRevision: number };
export type RegistryPage = { revision: number; total: number; nextCursor: string | null };
export type RpcMethodMap = {
  'terminal.create': { params: PrincipalContext & { workspaceId: string; cols: number; rows: number; requestId: string; protectionAcknowledgment?: 'linux-root-only-v1' /* deprecated, ignored */ }; result: { terminal: TerminalInfo } };
  'terminal.list': { params: PrincipalContext & { workspaceId?: string }; result: { terminals: TerminalInfo[] } };
  'terminal.watch': { params: PrincipalContext & { workspaceId?: string; after?: string }; result: { terminals: TerminalInfo[]; watchId: string; cursor: string; reset: boolean } };
  'terminal.unwatch': { params: Empty; result: { closed: true } };
  'terminal.capture': { params: PrincipalContext & { terminalId: string; start?: number; end?: number; stripAnsi?: boolean }; result: { lines: string[]; totalLines: number } };
  'terminal.attach': { params: PrincipalContext & { terminalId: string; after?: number; protectionAcknowledgment?: 'linux-root-only-v1' /* deprecated, ignored */ }; result: { terminal: TerminalInfo; nextSeq: number; gap?: { fromSeq: number; toSeq: number } } };
  'terminal.input': { params: PrincipalContext & { terminalId: string; data: string }; result: { bytes: number } };
  'terminal.resize': { params: PrincipalContext & { terminalId: string; cols: number; rows: number }; result: { cols: number; rows: number } };
  'terminal.close': { params: PrincipalContext & { terminalId: string }; result: { closed: true } };
  'terminal.revoke': { params: { principalId: string }; result: { closed: number } };
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

  'daemon.hello': { params: { protocolVersion: 1; client?: { name: string; version: string }; capabilities?: string[] }; result: { protocolVersion: 1; daemonVersion?: string; pid?: number; /** The daemon host's machine name (os.hostname()), a label for clients. */ hostname?: string; promptImageLimits?: { maxCount: number; maxBytes: number; maxTotalBytes: number }; attachmentLimits?: AttachmentLimits; terminalLimits?: TerminalLimits; capabilities?: string[] } };
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
  'catalog.get': { params: Empty; result: { models: Array<Record<string, unknown>>; modes: Array<Record<string, unknown>>; thinkingOptions?: unknown; defaultModel: string; fetchedAt?: string; providers?: Record<string, { status: string; fetchedAt?: string; error?: string }> } };
  'catalog.refresh': { params: Empty; result: { models: Array<Record<string, unknown>>; modes: Array<Record<string, unknown>>; thinkingOptions?: unknown; defaultModel: string; fetchedAt?: string; providers?: Record<string, { status: string; fetchedAt?: string; error?: string }> } };
  'assignment.recall': { params: { assignmentId?: string; taskId?: string; projectRoot?: string; question: string }; result: RecallAnswer };
  'board.list': { params: { projectRoot: string }; result: { pins: Pin[] } };
  'question.list': { params: { projectRoot?: string }; result: { questions: UserQuestion[] } };
  /** Capability `question.watch`: the waiting questions now; then this connection is told of every tree's `question` and `question.resolved` (of `projectRoot` when given). `turns` (capability `question.watch.turns`): also every root's `turn.ended`. `attention` (capability `session.attention`): also each root's attention, now and as it changes. */
  'question.watch': { params: { projectRoot?: string; turns?: boolean; attention?: boolean }; result: { questions: UserQuestion[]; attention?: Array<{ sessionId: string; attention: TurnAttention }> } };
  /** Capability `session.attention`: acknowledges a root's attention for every client; with `at`, only that one (a later turn's stays). */
  'session.attention.clear': { params: { sessionId: string; at?: string }; result: { cleared: boolean } };
  /** Capability `workspace.files`: files under `projectRoot` whose relative path matches `query`, best first; read-only, links not followed. */
  'workspace.files.search': { params: { projectRoot: string; query?: string; limit?: number }; result: { files: Array<{ path: string }>; truncated?: boolean } };
  /** Capability `workspace.files.read`: the entries of a directory under `projectRoot` (its root when `path` is left out); links, blocked and (unless `includeIgnored`) .gitignore'd entries left out. With `workspace.files.browse`: `cursor` pages past 1000 entries; `internalLinks` lists links inside the root as what they lead to (`target`). */
  'workspace.files.list': { params: { projectRoot: string; path?: string; includeIgnored?: boolean; cursor?: string; internalLinks?: boolean }; result: { entries: Array<{ name: string; path: string; kind: 'file' | 'directory'; size?: number; modifiedAt?: string; target?: string }>; truncated?: boolean; nextCursor?: string; target?: string } };
  /** Capability `workspace.files.read`: a UTF-8 text file under `projectRoot`, at most 1 MiB; read-only, links not followed. */
  'workspace.files.read': { params: { projectRoot: string; path: string; includeIgnored?: boolean }; result: { path: string; content: string; size: number; modifiedAt?: string } };
  /** Capability `workspace.files.browse`: every name under `projectRoot` holding `query`'s letters in order (or ending with it), in path order, in pages of a snapshot; read-only, links not entered. */
  'workspace.files.find': { params: { projectRoot: string; query?: string; kinds?: Array<'file' | 'directory'>; matchMode?: 'subsequence' | 'suffix'; limit?: number; cursor?: string }; result: { entries: Array<{ path: string; kind: 'file' | 'directory' }>; nextCursor?: string; truncated?: boolean } };
  /** Capability `workspace.files.browse`: a file under `projectRoot` as a preview, text, image or binary, at most 50 MiB, its bytes in chunks from `offset`. */
  'workspace.files.preview': { params: { projectRoot: string; path: string; includeIgnored?: boolean; internalLinks?: boolean; maxBytes?: number; offset?: number; revision?: string }; result: { path: string; target?: string; kind: 'text' | 'image' | 'binary'; mimeType: string; size: number; modifiedAt: string; revision: string; encoding: 'base64' | 'none'; content?: string; offset?: number; nextOffset?: number } };
  /** Capability `host.directories`: directories of the daemon host whose path completes `query` (absolute or under ~), or whose name matches it under the home directory. */
  'host.directories.search': { params: { query: string; limit?: number }; result: { entries: Array<{ path: string }>; truncated?: boolean } };
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
  'session.interrupt': { params: { sessionId: string; /** With session.interrupt.turn, cancel only this turn. */ turnId?: string }; result: { /** Conditional request only: false means the named turn is no longer active. */ interrupted?: boolean } };
  /**
   * Changes a session's permissions mode while idle; with capability `session.configure.live`, also a live
   * root's model, effort or team (§12.9): those need requestId and ifGeneration, apply at the idle barrier
   * through a restart of its native process on the same conversation, and answer `configured`. Answered
   * once per (sessionId, requestId): a repeat answers the first result with `duplicate: true`.
   */
  'session.configure': {
    params: { sessionId: string; mode?: string; model?: string; thinking?: string; team?: string; requestId?: string; ifGeneration?: string };
    result: { session: SessionSnapshot | SessionSummary; configured?: ConfigureOutcome; duplicate?: true };
  };
  /** What session.configure would run a live root with, and whether it would take it now (capability `session.configure.live`, §12.9). */
  'session.configure.preview': {
    params: { sessionId: string; mode?: string; model?: string; thinking?: string; team?: string };
    result: { preview: ConfigurePreview };
  };
  'session.close': { params: { sessionId: string }; result: Empty };
  'session.rename': { params: { sessionId: string; title: string }; result: { session: SessionSummary } };
  /**
   * A new root whose conversation is the source's up to a completed turn (capability `session.fork`, §12.7).
   * Answered once per (sessionId, requestId): a repeat answers the first result with `duplicate: true`.
   */
  'session.fork': {
    params: PrincipalContext & { sessionId: string; requestId: string; ifGeneration: string; boundary?: ForkBoundary; branchId?: string; workspaceId?: string; newSessionId?: string; title?: string };
    result: { session: SessionSummary; forkedFrom: ForkProvenance; duplicate?: true };
  };
  /**
   * The root's conversation from before a turn on, under the same session id; the later turns stay as a
   * recoverable branch and no file is changed (capability `session.rewind`, §12.7).
   */
  'session.rewind': {
    params: { sessionId: string; requestId: string; ifGeneration: string; beforeTurnId: string };
    result: { session: SessionSummary; generation: string; branch: ConversationBranch; duplicate?: true };
  };
  /**
   * Restarts a live root's native process on its own conversation and configuration at the idle
   * barrier, keeping its session id, history and receipts (capability `session.reload`, §12.8).
   * Answered once per (sessionId, requestId): a repeat answers the first result with `duplicate: true`.
   */
  'session.reload': {
    params: { sessionId: string; requestId: string; ifGeneration: string };
    result: { session: SessionSummary; duplicate?: true };
  };
  /**
   * The ALP CLI command that continues a session in a terminal, built by alpd (capability
   * `session.resumeCommand`, §12.8): argv and its POSIX and Windows command lines, for the clipboard only.
   */
  /**
   * Compacts a live root's context (t-0e56): main writes a checkpoint by skill compact, then its runtime
   * compacts, or ALP starts a fresh conversation seeded with it. Idle: now; otherwise at its next turn boundary.
   */
  'session.compact': {
    params: { sessionId: string };
    result: { status: 'started' | 'deferred' | 'running' };
  };
  'session.resumeCommand': {
    params: { sessionId: string };
    result: ResumeCommand;
  };
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
  'task.gate.resolve': { params: { projectRoot: string; id: string; gate: string; note?: string; ifRev?: number; /** One of a human gate's options; picking one approves it. */ choice?: string; /** Record the user's rejection instead (note is the reason); the gate stays open. */ reject?: boolean; /** Where the user decided, recorded on the gate. Default web. */ channel?: 'paseo' | 'web' }; result: { id: string; status: string; rev: number } };
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
