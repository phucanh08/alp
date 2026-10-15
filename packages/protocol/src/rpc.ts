/** Portable JSON-RPC structures; implementations and provider SDKs stay outside protocol. */
import type { RuntimeKind, Pin } from './dto.js';
import type { AlpError, Envelope, SessionSnapshot, TreeStatus, UserQuestion } from './events.js';
import type { PauseState, PromptContent, RecallAnswer, SessionPreview, SessionSpec, SessionSummary } from './session.js';

export type RpcId = string | number | null;
export type RpcErrorData = { code: number; message: string; data?: unknown };
export type RpcRequest = { jsonrpc: '2.0'; id?: RpcId; method: string; params?: Record<string, unknown> };
export type RpcResponse = { jsonrpc: '2.0'; id: RpcId } & ({ result: unknown; error?: never } | { error: RpcErrorData; result?: never });
export type EventNotification = { jsonrpc: '2.0'; method: 'event'; params: Envelope };

/** Names a daemon may list in its daemon.hello result (schema/methods-v1.json `capabilities`). */
export type Capability = 'attach.after' | 'prompt.receipts' | 'extension.methods';

/** `data.reason` values alpd sets on errors (docs/protocol/alp-json-rpc-v1.md §5.3). */
export type ErrorReason =
  | 'hello_required' | 'protocol_version' | 'invalid_params' | 'invalid_id' | 'batch_unsupported' | 'frame_too_large'
  | 'response_too_large' | 'persistence_failed' | 'outcome_unknown' | 'key_conflict';

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
};

export type RpcMethod = keyof RpcMethodMap;
export type RpcParams<M extends RpcMethod> = RpcMethodMap[M]['params'];
export type RpcResult<M extends RpcMethod> = RpcMethodMap[M]['result'];
