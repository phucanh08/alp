import type { RuntimeKind, MailEvent, Pin } from './dto.js';

/** Provider-neutral session events (plans/reference/ALPD.md §4). Viewers project them; the runtime never imports a viewer. */

/** `code: 'outcome_unknown'` when the provider may or may not have received the request (ALPD §66). */
export type AlpError = { message: string; code?: string };

export type TimelineItem =
  | {
    kind: 'user_message'; id: string; text: string; clientMessageId?: string; /** How many images the message carried; their data is not replayed. */ images?: number;
    /** Files attached to the message (capability `attachments`, §12.6): ids, display names, types and sizes, never a host path. */
    attachments?: Array<{ attachmentId: string; name: string; mimeType: string; size: number }>;
    /** Who wrote it: the user, or ALP itself (mail, a brief, a resume); absent when the runtime cannot tell. Only the user's words name a root (ALPD §15). */
    origin?: TurnOrigin;
  }
  | { kind: 'assistant_message'; id: string; text: string }
  /** Something about ALP as a whole the user should see, such as a usage limit or a pause (ALPD §29). */
  | { kind: 'notice'; id: string; level: 'info' | 'warning' | 'error'; text: string }
  /** The runtime compacting the session's context (ALPD §57). */
  | { kind: 'compaction'; id: string; status: 'running' | 'completed' | 'failed'; trigger?: 'auto' | 'manual'; preTokens?: number; postTokens?: number }
  /** The tasks a root's tree created or worked on (plans/reference/ALPD.md §21). */
  | { kind: 'todo'; id: string; items: Array<{ id: string; text: string; status: 'pending' | 'in_progress' | 'completed' }> }
  | {
      kind: 'tool_call';
      id: string;
      callId: string;
      name: string;
      status: 'running' | 'completed' | 'failed';
      error?: string;
      detail: ToolCallDetail;
    };

/**
 * What a tool call did, typed by kind (ALPD §4.2), in the shapes of Paseo's ToolCallDetail.
 * `shell` is a command; `unknown` the fallback with the tool's raw input and output. The typed
 * kinds between come from the runtime's own tools; filePath is the path the runtime reported.
 * The runtime clips each string field of a typed detail (not shell, not unknown) to 65,536
 * characters, filePaths to 200 entries and webResults to 50. A receiver shows a detail whose
 * type it does not know as unknown: new types may be added within v1.
 */
export type ToolCallDetail =
  | { type: 'shell'; command: string; cwd?: string; output: string; exitCode?: number | null }
  | { type: 'read'; filePath: string; content?: string; offset?: number; limit?: number }
  | { type: 'edit'; filePath: string; oldString?: string; newString?: string; unifiedDiff?: string }
  | { type: 'write'; filePath: string; content?: string }
  | {
      type: 'search';
      query: string;
      toolName?: 'search' | 'grep' | 'glob' | 'web_search';
      content?: string;
      filePaths?: string[];
      webResults?: Array<{ title: string; url: string }>;
      numFiles?: number;
      numMatches?: number;
      truncated?: boolean;
    }
  | { type: 'fetch'; url: string; prompt?: string; result?: string; code?: number }
  | { type: 'sub_agent'; subAgentType?: string; description?: string; log?: string }
  | { type: 'plan'; text: string }
  | { type: 'plain_text'; label?: string; text?: string }
  | { type: 'unknown'; input: unknown; output: unknown };

/**
 * How much a session has used, from its runtime's latest token report (ALPD §57), as Paseo's
 * AgentUsage: the context window's fill, the latest model response's tokens, and the session's
 * cost when the runtime says it. A field the runtime does not report is absent; a later report
 * replaces the fields it carries and keeps the others.
 */
export type SessionUsage = {
  /** Tokens the context holds now: the latest model call's input and output. */
  contextWindowUsedTokens?: number;
  /** The context window, once the runtime has said what it is. */
  contextWindowMaxTokens?: number;
  /** The latest model response's input tokens, of which cachedInputTokens came from cache, and output tokens. */
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  /** The session's cost in US dollars so far, as the runtime counts it (Claude, or ACP in USD). */
  totalCostUsd?: number;
};

export type SessionSnapshot = {
  id: string;
  projectRoot: string;
  agent: string;
  runtime: RuntimeKind;
  model: string;
  mode: string;
  thinking: string;
  workflow: { mode: string; maxPeers: number; supervisor: boolean };
  /** The label of the session's team, such as Phở (ALPD §42); absent for a custom graph. */
  teamLabel?: string;
  threadId: string;
  /** The native thread is kept and the session can be resumed. */
  persistent: boolean;
  parentId?: string;
  /** The requester's tool call that started this assignment. */
  toolCallId?: string;
  activeTurnId?: string;
  /** A turn, an assignment, a child, or undelivered mail keeps the session working. */
  busy: boolean;
  /** Why a usage limit or a pause parked this assignment (ALPD §29). */
  parked?: string;
  /** A digest of the instructions the session runs with (ALPD §34). */
  instructionsSha?: string;
  /** The session's runtime takes images in session.prompt (capability `prompt.images`); absent means it does not. */
  promptImages?: boolean;
  /**
   * How the session's runtime can use files attached in session.prompt (§12.6): `file.path` (its tools
   * read a staged read-only copy), `document.native`, `text.extract`. Absent: it takes no attachment parts.
   */
  promptAttachments?: Array<'file.path' | 'document.native' | 'text.extract'>;
  /** The latest usage the session's runtime reported (ALPD §57); absent before its first report. */
  usage?: SessionUsage;
};

export type AssignmentSnapshot = {
  id: string;
  agent: string;
  mode: string;
  status: string;
  startedAt: string;
  /** An isolated assignment's branch and working directory. */
  worktree?: { branch: string; path: string };
};

/** runtime: a turn the native runtime started by itself, such as Claude after a background task ended. */
export type TurnOrigin = 'user' | 'wake' | 'assignment' | 'runtime';

/**
 * A root's turn that ended while nobody looked (Paseo's attention): `finished` for a completed turn,
 * `error` for a failed one. alpd keeps it for every client until one acknowledges it or the root
 * starts another turn (docs/protocol/alp-json-rpc-v1.md §12.2).
 */
export type TurnAttention = { reason: 'finished' | 'error'; at: string; turnId?: string; message?: string };

/** A question an agent asked the user with alp_ask to: "user". */
export type UserQuestion = {
  id: string;
  sessionId: string;
  rootId: string;
  agent: string;
  body: string;
  options?: string[];
  askedAt: string;
};

export type SessionState = 'running' | 'waiting' | 'waiting_parent' | 'waiting_user' | 'idle';

/** A live tree at one moment, for dashboards (plans/reference/ALPD.md §17). */
export type TreeStatus = {
  rootId: string;
  sessions: Array<SessionSnapshot & { state: SessionState; idleMs: number; workdir: string; unreadMail: number }>;
  assignments: Array<AssignmentSnapshot & { requester: string; isolation: 'shared' | 'worktree'; idleMs: number }>;
  questions: UserQuestion[];
  /** Finished worktree assignments waiting for alp_merge or alp_discard. */
  worktrees: Array<{ assignmentId: string; requester: string; agent: string; branch: string; files: string[]; stat: string }>;
  leases: Array<{ checkout: string; assignmentId: string; agent: string }>;
  /** Live claims on the project board held by this tree's sessions. */
  claims: Pin[];
};

export type AlpEvent =
  | { type: 'session.opened'; session: SessionSnapshot; cwd: string; effective: { model: string; thinking: string } }
  | { type: 'session.ready' }
  /** `title` comes with alpd's announcement of a root's name (its first prompt, or `session.rename`). */
  | { type: 'session.updated'; session: SessionSnapshot & { title?: string } }
  | { type: 'session.closed' }
  | { type: 'session.failed'; error: AlpError }
  | { type: 'prompt.accepted'; clientMessageId: string; result: 'turn' | 'steer'; turnId: string }
  | { type: 'prompt.failed'; clientMessageId: string; error: AlpError }
  | { type: 'turn.started'; turnId: string; origin: TurnOrigin }
  | { type: 'turn.ended'; turnId: string; state: 'completed' | 'failed' | 'canceled'; error?: AlpError }
  | { type: 'item'; item: TimelineItem }
  /** The session's usage changed: the whole latest SessionUsage, not a delta (ALPD §57). */
  | { type: 'usage'; usage: SessionUsage }
  | { type: 'mail'; mail: Omit<MailEvent, 'passive' | 'deliveredTurn'> }
  | { type: 'assignment'; assignment: AssignmentSnapshot }
  | { type: 'question'; question: UserQuestion }
  | { type: 'question.resolved'; questionId: string; outcome: 'answered' | 'dismissed' | 'timeout' | 'canceled'; answer?: string }
  /** Emitted on the session that pinned it (plans/reference/ALPD.md §18). */
  | { type: 'pin'; pin: Pin }
  | { type: 'unpin'; pinId: string; reason: 'unpinned' | 'session_ended' }
  /** A root's attention set, or cleared when absent: sent only to `question.watch { attention: true }` connections, never kept. */
  | { type: 'attention'; attention?: TurnAttention }
  /**
   * The root's conversation was rewound (capability `session.rewind`, §12.7): history pages and cursors of
   * the earlier generation are stale. Sent to attached connections only, never kept: drop the cached
   * history, fetch a new tail and attach again with this generation.
   */
  | { type: 'history.reset'; generation: string; reason: 'rewind'; branchId: string };

export type Envelope = {
  sessionId: string;
  /** Random per runtime instance; a cursor from another epoch is stale. */
  epoch: string;
  /** Strictly increasing per session. */
  seq: number;
  /**
   * Position in its tree's stored timeline, set by alpd on the events it keeps: strictly
   * increasing per root across restarts, so `session.attach { after }` replays only what
   * a reconnecting client missed (ALPD §66).
   */
  cursor?: number;
  ts: string;
  event: AlpEvent;
};
