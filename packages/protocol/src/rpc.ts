/** Portable JSON-RPC structures; implementations and provider SDKs stay outside protocol. */
import type { RuntimeKind, Pin } from './dto.js';
import type { AlpError, Envelope, SessionSnapshot, TreeStatus, UserQuestion } from './events.js';
import type { PauseState, PromptContent, RecallAnswer, SessionPreview, SessionSpec, SessionSummary } from './session.js';
import type { EntryName, LanguageSetting, LibraryEntryRow, LibraryKind, LibraryScope, LibrarySource, TaskRow, TeamRow } from './dto.js';

export type RpcId = string | number | null;
export type RpcErrorData = { code: number; message: string; data?: unknown };
export type RpcRequest = { jsonrpc: '2.0'; id?: RpcId; method: string; params?: Record<string, unknown> };
export type RpcResponse = { jsonrpc: '2.0'; id: RpcId } & ({ result: unknown; error?: never } | { error: RpcErrorData; result?: never });
export type EventNotification = { jsonrpc: '2.0'; method: 'event'; params: Envelope };

/** Names a daemon may list in its daemon.hello result (schema/methods-v1.json `capabilities`). */
export type Capability = 'attach.after' | 'prompt.receipts' | 'extension.methods' | 'team' | 'task' | 'library' | 'settings.language';

/** `data.reason` values alpd sets on errors (docs/protocol/alp-json-rpc-v1.md §5.3). */
export type ErrorReason =
  | 'hello_required' | 'protocol_version' | 'invalid_params' | 'invalid_id' | 'batch_unsupported' | 'frame_too_large'
  | 'response_too_large' | 'persistence_failed' | 'outcome_unknown' | 'key_conflict'
  // Project, task and library methods (docs/protocol/alp-json-rpc-v1.md §5.3).
  | 'invalid_path' | 'invalid_scope' | 'invalid_entry' | 'secret_marker' | 'not_alp_project' | 'unknown_task' | 'not_found'
  | 'unsafe_path' | 'revision_conflict' | 'task_state' | 'in_use' | 'busy' | 'unreadable';

type Empty = Record<string, never>;

/**
 * Params and result of every v1 method, as schema/methods-v1.json defines them; the protocol tests
 * type-check the golden fixtures against this map, so the two cannot drift. Results may carry
 * properties this map does not name: clients ignore them.
 */
export type RpcMethodMap = {
  'daemon.hello': { params: { protocolVersion: 1; client?: { name: string; version: string }; capabilities?: string[] }; result: { protocolVersion: 1; daemonVersion?: string; pid?: number; capabilities?: string[] } };
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
  'question.answer': { params: { questionId: string; text?: string; dismiss?: boolean; reason?: string }; result: { questionId: string } };
  'session.create': {
    params: { sessionId?: string; spec: SessionSpec; history?: 'skip' | 'replay'; delegation?: boolean; resume?: boolean };
    result: { session: SessionSnapshot; attached: boolean; resumed?: true; durable?: boolean };
  };
  'session.preview': { params: { spec: SessionSpec }; result: { preview: SessionPreview } };
  'session.attach': { params: { sessionId: string; replay?: boolean; after?: number }; result: { session: SessionSummary; cursor: number; reset?: true } };
  'session.release': { params: { sessionId: string }; result: { closed: boolean } };
  'session.prompt': {
    params: { sessionId: string; clientMessageId: string; delivery?: 'auto' | 'steer'; content: PromptContent };
    /** `{}` from a daemon without prompt.receipts. */
    result: { outcome?: 'accepted' | 'failed'; error?: AlpError; duplicate?: boolean; durable?: boolean };
  };
  'session.interrupt': { params: { sessionId: string }; result: Empty };
  'session.configure': { params: { sessionId: string; mode?: string }; result: { session: SessionSnapshot } };
  'session.close': { params: { sessionId: string }; result: Empty };
  'session.rename': { params: { sessionId: string; title: string }; result: { session: SessionSummary } };
  'session.archive': { params: { sessionId: string; archived?: boolean }; result: { session: SessionSummary } };
  'session.get': { params: { sessionId: string }; result: { session: SessionSummary } };
  'session.list': { params: { projectRoot?: string; rootsOnly?: boolean; includeClosed?: boolean; includeArchived?: boolean }; result: { sessions: SessionSummary[] } };
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
    params: { kind: LibraryKind; name: EntryName; scope: LibraryScope; projectRoot?: string; content: Record<string, unknown>; revision?: string | null; sync?: 'none' | 'known-projects' };
    result: { revision: string | null; syncedProjects?: number; syncErrors?: string[] };
  };
  'library.delete': { params: { kind: LibraryKind; name: EntryName; scope: LibraryScope; projectRoot?: string; revision?: string }; result: { removed: true; now?: 'builtin' | 'library' } };
  'library.duplicate': { params: { kind: LibraryKind; from: EntryName; to: EntryName; scope: LibraryScope; projectRoot?: string }; result: { revision: string | null } };
  'library.rename': { params: { kind: LibraryKind; from: EntryName; to: EntryName; scope: LibraryScope; projectRoot?: string }; result: { revision: string | null } };
  'library.skills.set': { params: { agent: EntryName; skills: EntryName[] }; result: { skills: string[] } };
  'library.models': { params: Empty; result: { models: Array<{ id: string; label: string; efforts: string[]; effort?: string }> } };
  'settings.language.get': { params: Empty; result: LanguageSetting };
  'settings.language.set': { params: { language: string | null }; result: LanguageSetting };
};

export type RpcMethod = keyof RpcMethodMap;
export type RpcParams<M extends RpcMethod> = RpcMethodMap[M]['params'];
export type RpcResult<M extends RpcMethod> = RpcMethodMap[M]['result'];
