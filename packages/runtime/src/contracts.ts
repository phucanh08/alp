import type { ProviderFactories, ProviderRegistry } from './providers.js';
import type { RuntimeKind, SessionSpec } from './resolve.js';
import type { Envelope, SessionSnapshot, TreeStatus, UserQuestion } from './events.js';
import type { Pin } from './board.js';
import type { LiveEntry } from './live.js';
import type { ProviderUsage } from './usage.js';
import type { AcpProvider } from './acp-transport.js';
import type { AntigravityProvider } from './antigravity-transport.js';
import type { GitHubRunner } from './github.js';
import type { AttachmentReader } from './attachments.js';

export type RuntimeTransport = {
  request(method: string, params: any): Promise<any>;
  initialize(): Promise<void>;
  orchestrationContext?: () => Promise<unknown>;
  onNotification(listener: (method: string, params: any) => void): void;
  onFailure(listener: (error: unknown) => void): void;
  close(): Promise<void>;
  onRequest?: (listener: (method: string, params: any) => Promise<unknown>) => void;
  /** Whether turn input may hold images (`{ type: 'image', url: 'data:…' }`); omitted, Codex and Claude do. */
  takesImages?: () => boolean;
};

export type RuntimeOptions = {
  /** Native adapter overrides, isolated to this runtime; the legacy transport hook takes precedence. */
  providers?: ProviderFactories;
  /** An explicit registry, including custom adapter factories registered by the host. */
  providerRegistry?: ProviderRegistry;
  codexCommand?: string;
  claudeCommand?: string;
  antigravityCommand?: string;
  environment?: NodeJS.ProcessEnv;

  /**
   * Optional transport factory for tests/custom runtimes.
   * When omitted, ALP creates CodexTransport, ClaudeTransport, or AntigravityTransport itself.
   */
  transport?: (
    cwd: string,
    env: NodeJS.ProcessEnv,
    runtime?: RuntimeKind,
    /** The ACP provider, when runtime is acp. */
    acp?: AcpProvider,
    /** The Antigravity provider, when runtime is antigravity. */
    antigravity?: AntigravityProvider,
  ) => RuntimeTransport;

  /** An assignment with no activity this long is reported stalled; twice this long, it fails. */
  silentForMs?: number;
  /** How often main gets a check-in on its running assignments. Default 10 minutes; 0 turns it off. */
  checkInMs?: number;
  /** How often the watchdog looks at running assignments; derived from silentForMs and checkInMs when omitted. */
  watchMs?: number;
  /** How long alp_ask waits for the requester before returning unanswered. */
  askTimeoutMs?: number;
  /** How long alp_ask waits for the user before returning unanswered. Default 30 minutes. */
  userAskTimeoutMs?: number;

  /** Directory for per-root-session assignment logs (JSONL). Omitted disables logging. */
  runLogDir?: string;

  /** Starter files for projects without ALP; omitted reads the repository templates. */
  templates?: Record<string, string>;

  /** Where isolated assignments get their git worktrees. Default: a directory in the temp directory. */
  worktreeDir?: string;

  /** Where assignments whose profile has workdir copy get their disposable copies. Default: a directory in the temp directory. */
  copyDir?: string;

  /**
   * Where the runtime stages read-only copies of attached files for its sessions' tools (§12.6):
   * alpd's `<ALP_HOME>/state/staged`. Omitted, no session takes attachment parts.
   */
  attachmentStageDir?: string;

  /** Where project boards are kept (JSONL per project). Omitted keeps them in memory only. */
  boardDir?: string;

  /** The user's skill library and lessons (ALP_HOME). Omitted: only skills inside the project, and project lessons. */
  libraryDir?: string;

  /** The language the user reads; omitted, their settings.json's language, else Vietnamese (ALPD §54). */
  language?: string;

  /** Where finished assignments' native threads are recorded for alp_recall. Omitted keeps the record in memory. */
  recallFile?: string;
  /** Permanent assignment ownership; unlike recall, results never expire. */
  assignmentResultFile?: string;

  /** Where pauses are kept across restarts. Omitted keeps them in memory. */
  pauseFile?: string;

  /**
   * Resume a runtime a usage limit paused as soon as the runtime says the limit lifted
   * (ALPD §58). Default true; false tells the user instead, who resumes it.
   */
  autoResume?: boolean;
  /** How often alpd asks a runtime a usage limit paused whether the limit lifted. Default LIMIT_CHECK_MS. */
  limitCheckMs?: number;

  /** Where running assignments are kept, so the next alpd continues them (ALPD §31). Omitted keeps them in memory. */
  liveFile?: string;

  /** False parks assignments an earlier alpd left running until the user runs alp resume. Default true: they continue. */
  recoveryResume?: boolean;

  /** How the previous alpd ended, for what recovered sessions are told. */
  previousExit?: { kind: 'clean' | 'crash'; at?: string };

  /** False starts no supervisors, for hosts and tests that do not want them. Default true. */
  supervisor?: boolean;

  /** Runs the GitHub CLI for alp_issue. Default: `gh` (or ALP_GH_BIN) on PATH. */
  github?: GitHubRunner;
};

import type { NativeBase, OpenOptions, PromptContent, PromptInput } from '@anhlp/alp-protocol/session';
export type { NativeBase, OpenOptions, PromptContent, PromptInput } from '@anhlp/alp-protocol/session';

export type ScheduleHandler = (action: 'create' | 'list' | 'get' | 'cancel', params: Record<string, unknown>) => Promise<unknown>;

export type AlpRuntime = {
  /** The daemon supplies its persistent schedule operations; standalone runtimes have none. */
  bindSchedules?: (handler: ScheduleHandler | undefined) => void;
  /** alpd hands over its attachment reader (§12.6) once, at start; with a staging directory, Codex and Claude sessions then take attachment parts. */
  bindAttachments?: (reader: AttachmentReader | undefined) => void;
  /** Whether this live session's runtime takes `{ type: 'attachment' }` parts (RuntimeAttachment) now. */
  takesAttachments?: (sessionId: string) => boolean;
  /** Removes the staged copy of an attachment alpd no longer keeps. */
  dropAttachment?: (attachmentId: string) => Promise<void>;
  onEvent(listener: (envelope: Envelope) => void): () => void;
  /** Certifies a brand-new generated checkout; never use to adopt an existing workspace. */
  registerWorkspace(directory: string): Promise<void>;
  /** Reserves runtime admission while an external checkout mutation runs. */
  withWorkspaceMutation<T>(directory: string, run: () => Promise<T>): Promise<T>;
  /** Opens a root session under a client-chosen id. */
  open(sessionId: string, spec: SessionSpec, options?: OpenOptions): Promise<SessionSnapshot>;
  /** What a new root would run as, before it opens, and the teams it may choose (ALPD §60). */
  preview(spec: SessionSpec): Promise<SessionPreview>;
  /** Failures are reported as prompt.failed, once per clientMessageId. */
  prompt(sessionId: string, input: PromptInput): Promise<void>;
  /** Cancels the running turn and closes the whole subtree. */
  interrupt(sessionId: string): Promise<void>;
  /** Changes permission mode while idle; undefined keeps the current mode. */
  configure(sessionId: string, changes: { mode?: string }): Promise<SessionSnapshot>;
  close(sessionId: string): Promise<void>;
  snapshot(sessionId: string): SessionSnapshot | undefined;
  /** Live sessions, roots before their children. */
  list(): SessionSnapshot[];
  /** The live tree containing a session: sessions, assignments, questions, worktrees and leases. */
  status(sessionId: string): TreeStatus | undefined;
  /** Questions agents asked the user that wait for an answer. */
  questions(): UserQuestion[];
  /** Answers or dismisses a question to the user. */
  answer(questionId: string, reply: { text?: string; dismiss?: boolean; reason?: string }): void;
  /** Mails a note from the user to any live session, such as an assignment the user wants to redirect. */
  message(sessionId: string, text: string): void;
  /** The project board: live claims, then decisions and findings, oldest first. */
  board(projectRoot: string): Promise<Pin[]>;
  /** Holds delegation and wakes on one runtime, or all; now also parks running assignments there. */
  pause(input?: { runtime?: RuntimeKind; now?: boolean; reason?: string }): PauseState;
  /** Lifts a pause and continues the assignments it parked. Without a runtime, lifts every pause. */
  resume(input?: { runtime?: RuntimeKind }): PauseState;
  /** Current pauses and parked assignments. */
  pauses(): PauseState;
  /** Read-only, cached account usage for the web and desktop viewers. */
  usage(refresh?: boolean): Promise<{ providers: Array<ProviderUsage & { pause: Pause | null; parked: number }> }>;
  /** The user asks a finished assignment, or the last one on a task of the project, about its work. */
  recall(target: { assignmentId?: string; taskId?: string; projectRoot?: string }, question: string): Promise<RecallAnswer>;
  /** Assignments an earlier alpd left running, which recover() can continue once their root is open again. */
  recoverable(): LiveEntry[];
  /** Continues work in a reopened tree. continueRoot resumes its running turn; parkedRoot restores its held continuation intent. */
  recover(rootId: string, options?: { continueRoot?: boolean; parkedRoot?: string }): Promise<RecoveryOutcome[]>;
  /** Gives up the assignments of a tree whose root cannot be opened again: their tasks go back to open. */
  abandon(rootId: string, reason: string): Promise<RecoveryOutcome[]>;
  /** Closes everything; assignments still running stay in the live file, so the next alpd continues them. */
  shutdown(): Promise<void>;
  /**
   * Makes the native conversation a fork or rewind continues (docs/protocol/alp-json-rpc-v1.md §12.7): the
   * source's conversation cut at a completed turn, persisted by the runtime and leaving the source
   * unchanged. Touches no live session. Codex forks natively now (thread/fork); Claude validates the
   * cut against the transcript and answers a binding the first prompt forks (NativeBinding.base).
   * Refusals throw a ConversationError; one the runtime may or may not have acted on carries
   * `outcomeUnknown: true`. Absent: the host cannot fork or rewind.
   */
  branch?(request: BranchRequest): Promise<NativeBinding>;
  /**
   * Moves an idle live root to another native conversation (a rewind), or reopens its own (a reload):
   * its native process restarts and resumes `binding`, keeping the session id, its configuration and
   * attached viewers. Refused (ConversationError session_busy) unless the whole tree is idle: no turn,
   * pending prompt, child, assignment, question, mail or parked work. Emits session.updated.
   * When the new binding cannot be opened, the old one is reopened and the error thrown; when neither
   * opens, the session fails as a provider failure does.
   */
  rebind?(sessionId: string, binding: NativeBinding): Promise<SessionSnapshot>;
  /**
   * Restarts an idle live root's native process on the conversation it runs now (a reload, §12.8):
   * the same binding, the session's own configuration, id and viewers. Refused as rebind is. The new
   * process must resume that very conversation (a Claude one is refused unless its transcript, or its
   * base, exists), never an empty one in its place; when it cannot, the session closes with its
   * conversation kept (a later open resumes it) and a ConversationError native_refused is thrown.
   * Emits session.updated.
   */
  reload?(sessionId: string): Promise<SessionSnapshot>;
  /**
   * Holds the turns the runtime would start by itself on this session (mail wakes) while a lifecycle
   * operation changes its conversation (a rewind, later a reload or live configure): mail stays queued
   * and is delivered when the last hold is released, to whatever conversation the session runs then.
   * rebind does not refuse for mail a hold keeps. Client prompts are not held here; alpd holds them.
   * Undefined when the session is not open.
   */
  hold?(sessionId: string): (() => void) | undefined;
  /**
   * Whether an open session may begin a turn it has no id for yet: its turn/start (a prompt or a mail
   * wake) is on its way to the native runtime, or its native process is opening or restarting. Such a
   * turn shows in `activeTurnId` only once the runtime answers, and a hold taken meanwhile does not
   * stop it. False when the session is not open.
   */
  starting?(sessionId: string): boolean;
  /**
   * What a live root would run with after a change of model, thinking, team or mode (§12.9), and whether
   * reconfigure would take it now; reads only. `teams` are the teams the host defines for its project.
   */
  previewConfigure?(sessionId: string, changes: ConfigureChanges): Promise<ConfigurePreview>;
  /**
   * Changes an idle live root's model, thinking, team or mode (§12.9): resolves the new configuration
   * as session.create would (same runtime, agent and conversation; never more permissions or new
   * executable resources), then restarts its native process with it on the same conversation (`fresh`:
   * a root with no turn yet starts a new, empty one). The session takes the new configuration only
   * once the runtime took it (Codex echoes the model it resumed with); otherwise the old one is
   * restarted and a ConversationError thrown (`outcomeUnknown` when the runtime may have acted). A
   * new team also replaces the root's supervisor. Refused as rebind is while the tree is not idle.
   * Emits session.updated.
   */
  reconfigure?(sessionId: string, changes: ConfigureChanges, options?: { fresh?: boolean }): Promise<ConfigureResult>;
};

import type { ConfigureChanges, EffectiveConfig } from './configure.js';
export type { ConfigureChanges, EffectiveConfig } from './configure.js';
import type { ConfigurePreview } from '@anhlp/alp-protocol/session';
export type { ConfigurePreview } from '@anhlp/alp-protocol/session';
/** What reconfigure did: the session as it runs now, its effective configuration, and whether its process restarted. */
export type ConfigureResult = {
  session: SessionSnapshot;
  effective: EffectiveConfig;
  status: 'applied' | 'unchanged';
  restarted: boolean;
  /** What the native runtime answered it runs with (Codex: the resumed thread's model and effort). */
  native?: { model?: string; reasoningEffort?: string };
};

/** The native conversation a session continues: its thread, or for Claude one its first prompt makes from `base`. */
export type NativeBinding = { threadId: string; base?: NativeBase };

export type BranchRequest = {
  runtime: RuntimeKind;
  /** The conversation to branch: the source session's binding. */
  source: NativeBinding;
  /** Where the source session runs (Claude keeps its transcripts by this directory). */
  cwd: string;
  /** Where the branch will run; the source's cwd when absent. */
  targetCwd?: string;
  /** The configuration the branch keeps: Codex otherwise forks with its default model and settings. */
  model: string;
  thinking: string;
  mode: string;
  /**
   * The cut, by ALP turn id (a Codex turn id; a Claude prompt uuid): keep through a completed turn, or
   * everything before a turn. Absent: the whole conversation.
   */
  cutoff?: { throughTurnId: string } | { beforeTurnId: string };
  /** The source root's turns in order, as ALP's timeline has them, for the cut's validation. */
  turns: string[];
};

export type ConversationErrorReason = 'runtime_unsupported' | 'boundary_unmapped' | 'empty_prefix' | 'native_refused' | 'session_busy'
  // A live configure (§12.9).
  | 'runtime_mismatch' | 'agent_mismatch' | 'permission_escalation' | 'team_not_found' | 'invalid_params' | 'not_root';
/** A fork, rewind or rebind the runtime refused; `outcomeUnknown` when the native runtime may have acted. */
export class ConversationError extends Error {
  readonly data: { reason: ConversationErrorReason };
  readonly outcomeUnknown: boolean;
  constructor(reason: ConversationErrorReason, message: string, { outcomeUnknown = false } = {}) {
    super(message);
    this.name = 'ConversationError';
    this.data = { reason };
    this.outcomeUnknown = outcomeUnknown;
  }
}

import type { SessionPreview } from '@anhlp/alp-protocol/session';
export type { SessionPreview } from '@anhlp/alp-protocol/session';

/**
 * The team `alp init` names in a new project's settings (core INIT_TEAM). Kept for compatibility;
 * it is not the default of a session: preview and create both resolve that through core
 * `defaultTeam` (settings without workflow.mode run `custom`).
 */
export { INIT_TEAM as DEFAULT_TEAM } from '@anhlp/alp-core/workflow';

import type { RecoveryOutcome, Pause, PauseState } from '@anhlp/alp-protocol/session';
export type { RecoveryOutcome, Pause, PauseState } from '@anhlp/alp-protocol/session';

import type { RecallAnswer } from '@anhlp/alp-protocol/session';
export type { RecallAnswer } from '@anhlp/alp-protocol/session';
