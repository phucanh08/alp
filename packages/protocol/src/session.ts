import type { RuntimeKind } from './dto.js';
import type { SessionSnapshot, TurnAttention } from './events.js';
/** MCP servers a client adds to the agent's own; the agent's names win no collisions. */
export type HostMcpServer =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> };

/** What a client asks for; resolveSession turns it into a launchable session. */
export type SessionSpec = {
  cwd: string;
  agent?: string;
  /** Workflow selected for a new session; omitted uses settings or the restored snapshot. */
  workflow?: string;
  /** Native model, or runtime-prefixed (`codex:`/`claude:`, or `acp:<provider>[/<model>]`) to also choose the runtime. */
  model?: string;
  mode?: string;
  thinking?: string;
  systemPrompt?: string;
  env?: Record<string, string>;
  mcpServers?: Record<string, HostMcpServer>;
  /** Keep the native thread so the session can be resumed. */
  persist?: boolean;
  /** Keep the native thread on disk though the session cannot be resumed: an assignment, which alp_recall may question later. */
  keepThread?: boolean;
  restore?: { agent: string; threadId: string; runtime?: string; model?: string; workflow?: { mode: string; maxPeers: number; supervisor?: boolean } };
  /** Where the native harness works, when not the project root: an assignment's git worktree. ALP files are still read from cwd. */
  workdir?: string;
  /** Explicit shared-assignment write scope; workdir points here while ALP uses cwd for its project. */
  writeRoot?: string;
  /** The workdir is a disposable copy the session may write, though its mode is read-only for the requester's tree. */
  copy?: boolean;
  /** The requester's directory the copy mirrors. */
  copyOf?: string;
};

export type OpenOptions = {
  history?: 'replay' | 'skip';
  /** False when the client cannot show child sessions; delegation is then refused in this tree. */
  delegation?: boolean;
};

/** An image inline in a prompt (capability `prompt.images`): base64 data, never a path or URL; limits in PROMPT_IMAGES. */
export type PromptImage = { type: 'image'; mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string; name?: string };
/** Text parts carry `text`; image parts (`type: 'image'`) carry PromptImage's fields. */
export type PromptContent = Array<{ type: string; text?: string; mimeType?: string; data?: string; name?: string }>;

export type PromptInput = {
  clientMessageId: string;
  /** auto starts a turn; steer adds to the running one. */
  delivery: 'auto' | 'steer';
  content: PromptContent;
};

/** A root before it opens: the team and main it would run with, for viewers that let the user choose first (ALPD §60). */
export type SessionPreview = {
  teams: Array<{ id: string; label: string; description?: string }>;
  /** The team the spec selects, else settings' workflow.mode, else Phở. */
  team: string;
  teamLabel?: string;
  agent: string;
  runtime: RuntimeKind;
  model: string;
  mode: string;
  thinking: string;
};

/** What became of one assignment an earlier alpd left running. */
export type RecoveryOutcome = { assignmentId: string; agent: string; outcome: 'resumed' | 'parked' | 'failed'; error?: string };

export type Pause = { since: string; by: string; reason: string; resetsAt?: string; /** When alpd last asked the runtime about the limit (ALPD §58). */ checkedAt?: string };
export type PauseState = {
  all?: Pause;
  runtimes: Partial<Record<RuntimeKind, Pause>>;
  parked: Array<{ assignmentId: string; agent: string; runtime: RuntimeKind; rootId: string; reason: string; since: string }>;
};

export type RecallAnswer = { assignmentId: string; agent: string; taskId?: string; finishedAt: string; answer: string };

/** A session's lifecycle as alpd records it; neutral, so viewers and integrations share one union. */
export type SessionStatus = 'initializing' | 'idle' | 'running' | 'error' | 'closed';

/** The last failure recorded for a session (daemon store `SessionRecord.lastError`). */
export type SessionError = { code?: string; message: string };

/**
 * A session as clients list it: its last snapshot plus lifecycle (ALPD §18). This is the portable
 * shape served by `session.list`; the daemon and every viewer agree on it, so it is the same type
 * the daemon's store and server use rather than a lossy summary.
 */
export type SessionSummary = SessionSnapshot & {
  status: SessionStatus;
  title?: string;
  archived?: boolean;
  /** A root's turn that ended unseen, until a client acknowledges it (capability `session.attention`). */
  attention?: TurnAttention;
  lastError?: SessionError;
  createdAt?: string;
  updatedAt?: string;
};
