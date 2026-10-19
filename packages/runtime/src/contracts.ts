import type { ProviderFactories, ProviderRegistry } from './providers.js';
import type { RuntimeKind, SessionSpec } from './resolve.js';
import type { Envelope, SessionSnapshot, TreeStatus, UserQuestion } from './events.js';
import type { Pin } from './board.js';
import type { LiveEntry } from './live.js';
import type { ProviderUsage } from './usage.js';
import type { AcpProvider } from './acp-transport.js';
import type { AntigravityProvider } from './antigravity-transport.js';
import type { GitHubRunner } from './github.js';

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

  /** Where project boards are kept (JSONL per project). Omitted keeps them in memory only. */
  boardDir?: string;

  /** The user's skill library and lessons (ALP_HOME). Omitted: only skills inside the project, and project lessons. */
  libraryDir?: string;

  /** The language the user reads; omitted, their settings.json's language, else Vietnamese (ALPD §54). */
  language?: string;

  /** Where finished assignments' native threads are recorded for alp_recall. Omitted keeps the record in memory. */
  recallFile?: string;

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

import type { OpenOptions, PromptContent, PromptInput } from '@anhlp/alp-protocol/session';
export type { OpenOptions, PromptContent, PromptInput } from '@anhlp/alp-protocol/session';

export type AlpRuntime = {
  onEvent(listener: (envelope: Envelope) => void): () => void;
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
};

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
