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
  restore?: {
    agent: string; threadId: string; runtime?: string; model?: string; workflow?: { mode: string; maxPeers: number; supervisor?: boolean };
    /** Claude: `threadId` does not exist yet and is made from this conversation on its first prompt (a fork or rewind, §12.7). */
    base?: NativeBase;
  };
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
/** A stored attachment in a prompt (capability `attachments`, §12.6): its opaque id only, never a path or URL. */
export type PromptAttachment = { type: 'attachment'; attachmentId: string };
/**
 * What alpd hands a runtime for an attachment part once it validated and pinned it (§12.6, the
 * runtime seam of issue #121 branch J): ids, display metadata and digest, never a host path. The
 * runtime reads the bytes through the AttachmentReader alpd binds, and only for a session whose
 * runtime declared it takes attachments.
 */
export type RuntimeAttachment = { type: 'attachment'; attachmentId: string; name: string; mimeType: string; detectedMimeType: string; size: number; sha256: string };
/** Text parts carry `text`; image parts (`type: 'image'`) carry PromptImage's fields; attachment parts (`type: 'attachment'`) `attachmentId`. */
export type PromptContent = Array<{ type: string; text?: string; mimeType?: string; data?: string; name?: string; attachmentId?: string }>;

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
  /**
   * Whether alpd can fork or rewind this session's conversation now, and why not (capabilities
   * `session.fork` and `session.rewind`, §12.7). A single turn may still be refused: one in
   * progress, the first one, or one alpd cannot map to the runtime's own history.
   */
  conversation?: {
    fork: boolean; rewind: boolean;
    /** Whether session.reload can restart this root's native process (capability `session.reload`, §12.8); the root must also be open and idle. */
    reload?: boolean;
    /** Whether session.configure can change this root's model, effort or team (capability `session.configure.live`, §12.9); the root must also be open and idle. */
    configure?: boolean;
    reason?: 'runtime_unsupported' | 'not_persistent' | 'not_root';
  };
  /** The session this root was forked from (§12.7). */
  forkedFrom?: ForkProvenance;
  /** Conversation branches rewinds set aside, oldest first; each stays recoverable with session.fork { branchId } (§12.7). */
  branches?: ConversationBranch[];
};

/**
 * A Claude conversation ALP has bound a session to but the runtime has not written yet (§12.7): the
 * first prompt resumes `threadId` as a new session, keeping its history through the entry `at` (all of
 * it when absent). Internal to alpd and its runtime; never accepted from a remote client.
 */
export type NativeBase = { threadId: string; at?: string };

/** Where a fork came from (§12.7): the source root, and the turn its conversation was cut at. */
export type ForkProvenance = {
  sessionId: string;
  /** The cut: through this turn, or before it; absent when the whole conversation was taken. */
  turnId?: string;
  boundary: 'through' | 'before' | 'whole';
  /** Set when the fork restored a branch a rewind set aside. */
  branchId?: string;
  at: string;
};

/** The later turns of a conversation a rewind set aside (§12.7): kept, never deleted, recoverable as a new session. */
export type ConversationBranch = {
  branchId: string;
  /** The turn the rewind went back to before; it and every later turn are in the branch. */
  beforeTurnId: string;
  /** How many turns the branch holds past the kept conversation. */
  turns: number;
  at: string;
};

/**
 * The ALP CLI command that continues a session in a terminal (session.resumeCommand, §12.8): `argv`
 * and the same command quoted for a POSIX shell and for Windows (cmd.exe). `display` is the one for
 * the daemon host's own platform. Never a native runtime's command, credential, env or path.
 */
export type ResumeCommand = { argv: string[]; posix: string; windows: string; display: string; platform: 'posix' | 'windows' };

/**
 * The configuration a root runs with, or would after a change, as alpd resolved it (§12.9): its team,
 * agent, runtime, model, effort and mode, and what they bring (delegation targets, ALP tools, MCP
 * servers by name and kind, hook count, an instructions digest). Never a path, command or credential.
 */
export type EffectiveConfig = {
  team: string;
  teamLabel?: string;
  agent: string;
  runtime: RuntimeKind;
  model: string;
  thinking: string;
  mode: string;
  /** The permission profile capping the agent's mode, when one does. */
  permissionProfile?: string;
  supervisor: boolean;
  maxPeers?: number;
  delegates: string[];
  tools: string[];
  mcpServers: Array<{ name: string; kind: 'stdio' | 'http' }>;
  hooks: number;
  instructionsSha?: string;
};

export type ConfigureChange = 'model' | 'thinking' | 'team' | 'mode';
export type ConfigureRefusal = 'session_busy' | 'session_closed' | 'not_root' | 'runtime_unsupported' | 'runtime_mismatch' | 'agent_mismatch' | 'permission_escalation' | 'team_not_found' | 'invalid_params' | 'not_persistent';

/** session.configure.preview (§12.9): the current and proposed configuration, and whether alpd would apply it now. */
export type ConfigurePreview = {
  current: EffectiveConfig;
  proposed: EffectiveConfig;
  changes: ConfigureChange[];
  /** Applying it restarts the root's native process on its own conversation. */
  restart: boolean;
  /** session.configure would take it now; a tree that gets busy meanwhile still refuses it. */
  allowed: boolean;
  reason?: ConfigureRefusal;
  message?: string;
  teams: Array<{ id: string; label: string; description?: string }>;
};

/** What a session.configure with model, thinking or team did (§12.9): what was asked, and what the root runs with now. */
export type ConfigureOutcome = {
  status: 'applied' | 'unchanged';
  requested: { model?: string; thinking?: string; team?: string; mode?: string };
  effective: EffectiveConfig;
  restarted: boolean;
};
