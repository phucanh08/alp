import { createAssignmentResults } from './assignment-results.js';
import { constants as fsConstants } from 'node:fs';
import type { Session, Assignment, Waiter } from './session-state.js';
import { errorData, plainObject, toolResult } from './tool-results.js';
import { createLogger } from '@anhlp/alp-core/log';
import { PROMPT_IMAGES, base64Bytes } from '@anhlp/alp-protocol';
import { createBoardDomain } from './board-domain.js';
import { ATTACHMENT_ROUTES, STAGED_PATH, attachmentPart, createAttachmentStager, runtimeAttachment, stagingExposure, type AttachmentReader, type AttachmentRoute } from './attachments.js';
import type { RuntimeAttachment } from '@anhlp/alp-protocol/session';
import { createWorktreeDomain } from './worktree-domain.js';
import { type RuntimeTransport, type RuntimeOptions, type OpenOptions, type PromptContent, type PromptInput, type AlpRuntime, type SessionPreview, type RecoveryOutcome, type Pause, type PauseState, type RecallAnswer, type ScheduleHandler, type BranchRequest, type NativeBinding, type ConfigurePreview, type ConfigureResult, type ConversationErrorReason, ConversationError } from './contracts.js';
import { claudeCut, codexForkEnd, codexForkRefusal, pendingChain, type ChainEntry } from './conversation.js';
export type { RuntimeTransport, RuntimeOptions, OpenOptions, PromptContent, PromptInput, AlpRuntime, SessionPreview, RecoveryOutcome, Pause, PauseState, RecallAnswer } from './contracts.js';
export { DEFAULT_TEAM } from './contracts.js';
import { verdictLine, parseHandoff, type Handoff } from './handoff.js';
import { TASK_ACTIONS, TASK_PAST, TASK_FIELDS, mainOf, roleOf, taskActions, taskBrief, type TaskAction } from './tools.js';
import { nativeEnvironment, createTransport } from './providers.js';
import { nativeMode, codexApproval, profileEfforts, nativeSessionConfig } from './session-config.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { appendFile, mkdir, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { moveFile } from '@anhlp/alp-core/atomic';
import os from 'node:os';
import path from 'node:path';
import { resolveDelegation } from '@anhlp/alp-core/delegation';
import { discoverAgents } from '@anhlp/alp-core/resolver';

import { acpDecision, acpWhat, type AcpPermission } from './acp-transport.js';

import { models, modes, thinkingOptionsFor, withinMode, writes } from './catalog.js';
import { runHook } from '@anhlp/alp-core/hook-run';
import { hookMatches } from '@anhlp/alp-core/hooks';
import { isTrusted, trustProject } from '@anhlp/alp-core/trust';
import { listTeams, teamOf } from '@anhlp/alp-core/teams';
import { CONFIGURABLE, changesOf, effectiveOf, executablesOf, nativeModelOf, offered, type ConfigureChange, type ConfigureChanges, type EffectiveConfig } from './configure.js';
import { anyModel, offers, profileModel, selectedProfile } from '@anhlp/alp-core/profiles';
import { LESSONS_FILE, READ_ONLY_AGENTS, resolveSession, type ResolvedSession, type RuntimeKind, type SessionSpec } from './resolve.js';
import { MAIL_BODY_CHARS, MAIL_HEADER, publicEvent, renderMail, takeBatch, USER, type MailEvent } from './mailbox.js';
import type { AlpEvent, AssignmentSnapshot, Envelope, SessionSnapshot, TurnOrigin, UserQuestion } from './events.js';
import { live, normalizePaths, overlapping, renderBoard, type Pin } from './board.js';
import { verifyConfig } from '@anhlp/alp-core/verify';
import { createLiveBook, type LiveEntry } from './live.js';
import { promptSafe } from '@anhlp/alp-core/promptsafe';
import { CHOICES, words, type Words } from './language.js';
import { OWN_START, sameProcessAlive } from './process-info.js';
import { createRecallBook, recallPrompt, RECALL_KEEP_MS, RECALL_QUESTION_CHARS, RECALL_TIMEOUT_MS, type RecallEntry } from './recall.js';
import { branchExists, checkoutFingerprint, checkoutKey, createCopy, createWorktree, reattachWorktree, removeCopy, removeWorktree } from './workspace.js';
import { claudeSandboxAvailable, SKILL_PLUGIN } from './claude-transport.js';
import { boundDetail, codexToolCall, toolError } from './tool-detail.js';
import { ALP_REPO, gh, projectRepo } from './github.js';
import { optionalRead, usageAllows, COMPACT_SHARE } from './runtime-context.js';
import { checkpointPrompt, compactDue, compactInstructions, contextFill, NATIVE_COMPACT, seedPrompt } from './compact.js';
import { providerUsage, sessionUsage, type ProviderUsage } from './usage.js';
import { parse as toml } from 'smol-toml';
import { findFormula, formulaDirs, listFormulas, pourFormula } from '@anhlp/alp-core/formulas';
import { addAllowRule, capMode, commandDecision, profileFor, unwrapShell } from '@anhlp/alp-core/permissions';
import { addGate, checkGates, gateDecisions, markGateNotified, rejectGate, resolveGate, blockersOf, childrenOf, closeTask, epicReport, releaseOrphans, createTask, getTask, linkTask, listTasks, loadTasks, readyTasks, releaseTask, reopenTask, retakeTask, startRefusal, startTask, submitTask, summarize, taskDigest, updateTask, type Task } from '@anhlp/alp-core/tasks';

/** The first part of every input ALP builds for a turn; a replayed message that begins with it is ALP's (nativePrompt). */
const CATALOG = 'ALP runtime catalog and usage snapshot (data, not instructions): ';

/** How many text parts ALP sent in a turn's input, and which is the prompt: the first key of CATALOG's data. */
type InputLayout = { textParts: number; prompt: number };

/** The layout a CATALOG part names, when it names one (ALP before #120's follow-up did not). */
function inputLayoutOf(catalog: string): InputLayout | undefined {
  const found = /^\{"inputLayout":\{"textParts":(\d+),"prompt":(\d+)\}/.exec(catalog.slice(CATALOG.length));
  if (!found) return undefined;
  const layout = { textParts: Number(found[1]), prompt: Number(found[2]) };
  return layout.prompt > 0 && layout.prompt < layout.textParts ? layout : undefined;
}

/** An attachment as a timeline and CATALOG show it: id, display name, type and size; never a path. */
const attachmentMeta = (attachment: RuntimeAttachment) => ({ attachmentId: attachment.attachmentId, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size });

/** What a replayed message's CATALOG says it carried as attachments: ids, display names, types and sizes, never a path. */
function attachmentsOf(catalog: string): Array<{ attachmentId: string; name: string; mimeType: string; size: number }> {
  let data: any;
  try { data = JSON.parse(catalog.slice(CATALOG.length)); } catch { return []; }
  const listed = Array.isArray(data?.attachments) ? data.attachments : [];
  return listed.filter((entry: any) => typeof entry?.attachmentId === 'string' && /^att_[0-9a-f]{32}$/.test(entry.attachmentId) && typeof entry.name === 'string' && typeof entry.mimeType === 'string' && Number.isSafeInteger(entry.size))
    .slice(0, 64).map((entry: any) => ({ attachmentId: entry.attachmentId, name: entry.name, mimeType: entry.mimeType, size: entry.size }));
}
/**
 * Who wrote a message ALP sent, from the id it sent it under: ALP's own ids are `alp-wake-`,
 * `alp-mail-`, `alp-review-`, `alp-resume-`, `alp-recover-` and `task-`; any other id is a client's
 * (the user's, or a job the user scheduled).
 */
function promptOrigin(clientMessageId: string, session: { parent?: string }): TurnOrigin {
  if (/^alp-(wake|mail)-/.test(clientMessageId)) return 'wake';
  if (/^(alp-review-|task-)/.test(clientMessageId)) return 'assignment';
  if (/^alp-(resume|recover)-/.test(clientMessageId)) return session.parent ? 'assignment' : 'wake';
  return 'user';
}
const MAX_WAKES = 8;
/** How long the user may wait for main's first words before its tool results remind it. */
const USER_REPLY_MS = 60_000;

/** What a waiting session hears when the user wrote to it. */
const USER_WROTE = 'The user just wrote to you; their message follows. Answer them first in a short message they can read (tool calls alone show them nothing), and steer an assignment with alp_send when their words change its brief. Your assignments keep running: then alp_wait again, or end your turn and ALP wakes you with their results.';
/** A wait cut short by the end of its turn: what it waited for goes on. */
const TURN_ENDED = 'Turn ended before the result arrived. Running assignments keep running; ALP wakes you with their results as mail.';
/** What a waiting session hears with a check-in, or mail from its requester or the user. */
const CHECKED_IN = 'Not a result: the assignment keeps running. Act on this mail first (a steer from your requester or the user\'s words may change what your assignments should do: pass that on with alp_send), then alp_wait again or end your turn.';
/** A session's native process is restarted at most RESTART_LIMIT times within RESTART_WINDOW_MS unless it makes progress meanwhile. */
const RESTART_LIMIT = 3;
const RESTART_WINDOW_MS = 10 * 60_000;
/** How often alpd asks a runtime a usage limit paused whether the limit lifted (ALPD §58). */
const LIMIT_CHECK_MS = 60_000;
/** A check this recent answers a delegation without asking the runtime again. */
const LIMIT_FRESH_MS = 15_000;
/**
 * The context advisory (ALPD §57): the runtime compacts a full context and keeps going, so
 * ALP says nothing until a session's fill reaches CONTEXT_SOON of the point where its
 * runtime compacts, and then once. Below CONTEXT_RESET of it, as after a compaction, it may
 * come again. Where the runtime does not say that point, it is COMPACT_SHARE of the window.
 */
const CONTEXT_SOON = 0.9;
const CONTEXT_RESET = 0.5;
/** After a failed compaction, how long the automatic one waits before it tries again (t-0e56). */
const COMPACT_RETRY_MS = 10 * 60_000;

/** How much of an assignment's brief ALP repeats after a compaction. */
const BRIEF_CHARS = 8000;
// Placeholder delivery marks while a steer or a woken turn is starting.
const STEERING = '\u0000steering';
const STARTING = '\u0000starting';

/** Answers that approve a proposal; anything else is feedback. */
const APPROVALS = ['approve', 'approved', 'yes', 'y', 'ok', 'đồng ý', 'duyệt', 'có'];
const CHOICES_REJECT = ['reject', 'từ chối'];
const SKILL_BODY_CHARS = 20_000;
const STARTER_ROLES = ['main', 'lead', 'peer', 'oracle', 'reviewer', 'supervisor'];
const ISSUE_BODY_CHARS = 20_000;
const ISSUE_FOOTER = '\n\n---\n_Drafted by an ALP agent and posted with the user\'s approval._';

const LESSON_CHARS = 600;
const DIGEST_CHARS = 12_000;
const JOURNAL_LINE_CHARS = 400;
/** Journal lines carry the local time, so the supervisor sees how long the user waited. */
const clock = (at = Date.now()) => new Date(at).toTimeString().slice(0, 8);
const stamp = (line: string, at = Date.now()) => `[${clock(at)}] ${line}`;
const unstamped = (line: string) => line.replace(/^\[\d\d:\d\d:\d\d\] /, '');
const span = (ms: number) => ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`;
/** A token count as people say it: 164k, 1M. */
const thousands = (tokens: number) => tokens >= 1_000_000 && tokens % 1_000_000 < 50_000 ? `${Math.round(tokens / 1_000_000)}M` : `${Math.round(tokens / 1000)}k`;

/** Cuts text to `limit` characters, keeping its lines. */
const cut = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
const clip = (text: string, limit = JOURNAL_LINE_CHARS) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};

/**
 * The runtime speaks a normalized protocol to its transport.
 *
 * CodexTransport, ClaudeTransport and AcpTransport map it to each native harness.
 *
 * The runtime therefore owns orchestration only; the transport adapters
 * preserve the full native harness underneath.
 */
const isolationOf = (args: { isolation?: string }) => args.isolation ?? 'shared';

const log = createLogger({ component: 'runtime' });

export type WorkspaceMutationReason = 'workspace_busy' | 'workspace_claimed' | 'workspace_leased' | 'workspace_assignment_result';
export class WorkspaceMutationError extends Error {
  readonly data: { reason: WorkspaceMutationReason };
  constructor(reason: WorkspaceMutationReason, message: string) {
    super(message);
    this.name = 'WorkspaceMutationError';
    this.data = { reason };
  }
}

export function createAlpRuntime(options: RuntimeOptions = {}): AlpRuntime {
  const sessions = new Map<string, Session>();
  /** Queue slots preparing a scheduled prompt, before its native turn/start. */
  const admittedPrompts = new Set<string>();
  /** What ALP writes for the user of a session, in their language (ALPD §54). */
  const wordsFor = (session: Session) => words(session.mapping.language);

  const childContexts = new Map<
    string,
    {
      parent: string;
      callId: string;
      graph: Record<string, string[]>;
      workflow: ResolvedSession['workflow'];
      ancestry: string[];
      role?: 'supervisor';
      /** Reopened after alpd restarted: its requester may be idle. */
      recovered?: boolean;
    }
  >();

  const listeners = new Set<(envelope: Envelope) => void>();
  const epoch = randomUUID();
  /** Finished assignments whose native threads alp_recall can question. */
  const recalls = createRecallBook(options.recallFile);
  const assignmentResults = createAssignmentResults(options.assignmentResultFile);
  /** Running assignments, so the next alpd continues them (ALPD §31). */
  const inFlight = createLiveBook(options.liveFile);
  /** Those an earlier alpd left running; recover() takes them once their root is open again. */
  let inherited = inFlight.all().filter(entry => entry.epoch !== epoch);
  /** Pauses by runtime, or of everything; kept in pauseFile across restarts. */
  let paused: { all?: Pause; runtimes: Partial<Record<RuntimeKind, Pause>> } = { runtimes: {} };
  try {
    const stored = options.pauseFile ? JSON.parse(readFileSync(options.pauseFile, 'utf8')) : undefined;
    if (stored && typeof stored === 'object') paused = { ...(stored.all ? { all: stored.all } : {}), runtimes: stored.runtimes && typeof stored.runtimes === 'object' ? stored.runtimes : {} };
  } catch {}
  let pauseWrites = Promise.resolve();
  /** The latest usage report of each runtime, and the warnings already given, by runtime and reset time. */
  const usage = new Map<RuntimeKind, any>();
  const warned = new Set<string>();
  /** The check of each runtime's limit running now, and when the last one ended (ALPD §58). */
  const limitChecks = new Map<RuntimeKind, { at: number; running?: Promise<void> }>();
  let limitWatch: NodeJS.Timeout | undefined;
  /** Limit pauses whose lifting the user was told of, when ALP does not resume by itself. */
  const liftTold = new WeakSet<Pause>();
  /** Write leases: one writing assignment per checkout across all trees, unless nested under the holder. */
  const leases = new Map<string, { assignment: string; agent: string }>();
  const worktreeRoot = options.worktreeDir ?? path.join(os.tmpdir(), 'alp-worktrees');
  const copyRoot = options.copyDir ?? path.join(os.tmpdir(), 'alp-copies');
  /** Non-image attachments (§12.6): staged copies when alpd gave a directory, read from alpd's reader once it binds one. */
  const stager = options.attachmentStageDir ? createAttachmentStager(options.attachmentStageDir) : undefined;
  let attachmentReader: AttachmentReader | undefined;
  /** Sessions already warned that the staging directory is inside their workspace. */
  const stagingWarned = new Set<string>();
  if (stager) void stager.sweep();
  const sequences = new Map<string, number>();

  let workspaceMutation = false;
  let admitting = 0;
  const refuseMutation = (reason: WorkspaceMutationReason, message: string): never => { throw new WorkspaceMutationError(reason, message); };
  // Admission registers synchronously, before resolving configuration or creating copies.
  async function admission<T>(run: () => Promise<T>): Promise<T> {
    if (workspaceMutation) refuseMutation('workspace_busy', 'A workspace mutation is in progress; retry after it finishes');
    admitting++;
    try { return await run(); } finally { admitting--; }
  }
  let closed = false;
  let queue = Promise.resolve();

  const emit = (sessionId: string, event: AlpEvent) => {
    // The staging directory never reaches a timeline: a tool's command or output, or a reply, that names
    // a staged copy shows it under STAGED_PATH (§12.6). Clients know attachments by id and name.
    if (stager) {
      const json = JSON.stringify(event);
      const named = stager.spellings().map(root => JSON.stringify(root).slice(1, -1)).filter(root => json.includes(root));
      // The directory itself, not a longer name that starts like it (`staged-old`, `staged.bak`); a period ending a sentence is not a name.
      if (named.length) event = JSON.parse(named.reduce((text, root) => text.replace(new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_-])`, 'g'), STAGED_PATH), json));
    }
    const seq = (sequences.get(sessionId) ?? 0) + 1;
    sequences.set(sessionId, seq);
    const envelope: Envelope = { sessionId, epoch, seq, ts: new Date().toISOString(), event };
    for (const listener of listeners) listener(envelope);
  };

  /** Public operations run one at a time, so a wake never races a client prompt or an interrupt. */
  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(() => {
      if (closed) throw new Error('Runtime is closed');
      return work();
    });
    queue = run.then(() => {}, () => {});
    return run;
  }

  /** Whether the session's runtime takes images in a prompt: the transport says, else Codex and Claude do. */
  function takesImages(session: Session) {
    return session.runtime.takesImages ? session.runtime.takesImages() : session.runtimeKind === 'codex' || session.runtimeKind === 'claude';
  }

  /** How the session's runtime can use attached files (the capability matrix of §12.6); none without alpd's reader and a staging directory. */
  function attachmentRoutes(session: Session): readonly AttachmentRoute[] {
    return stager && attachmentReader ? ATTACHMENT_ROUTES[session.runtimeKind] ?? [] : [];
  }

  function snapshot(sessionId: string, session: Session): SessionSnapshot {
    return {
      id: sessionId,
      projectRoot: session.mapping.agent.projectRoot,
      agent: session.mapping.agent.name,
      runtime: session.runtimeKind,
      model: session.mapping.model,
      mode: session.mapping.mode,
      thinking: session.mapping.thinking,
      workflow: session.mapping.workflow,
      ...(session.mapping.team ? { teamLabel: session.mapping.team.label } : {}),
      threadId: session.threadId,
      persistent: session.mapping.persist,
      ...(session.parent ? { parentId: session.parent } : {}),
      ...(session.toolCallId ? { toolCallId: session.toolCallId } : {}),
      ...(session.active ? { activeTurnId: session.active } : {}),
      // turn.ended listeners persist the intent before terminal() finishes parking it.
      ...((session.parked?.reason ?? session.parkReason) ? { parked: session.parked?.reason ?? session.parkReason } : {}),
      ...(session.instructionsSha ? { instructionsSha: session.instructionsSha } : {}),
      ...(takesImages(session) ? { promptImages: true } : {}),
      ...(attachmentRoutes(session).length ? { promptAttachments: [...attachmentRoutes(session)] } : {}),
      ...(session.usage ? { usage: session.usage } : {}),
      busy: !!(session.active || session.pending || session.parked || session.parkReason || session.children.size || session.assignments.size || hasActiveMail(session) || reviewing(session)),
    };
  }

  function terminal(
    sessionId: string,
    session: Session,
    state: 'completed' | 'failed' | 'canceled',
    error?: unknown,
  ) {
    if (!session.active) return;

    emit(sessionId, {
      type: 'turn.ended',
      turnId: session.active,
      state,
      ...(error ? { error: errorData(error) } : {}),
    });

    const turnId = session.active;
    session.active = undefined;
    void runHooks(sessionId, session, 'turn.end', { turn: { id: turnId, state } });

    // Tool calls of the ended turn stop waiting.
    for (const waiter of session.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    cancelQuestions(sessionId, true);
    if (session.parent) sessions.get(session.parent)?.assignments.get(sessionId)?.ask?.resolve(toolResult(false, { error: 'Turn ended' }));

    // Mail is acknowledged only by a turn that completed; otherwise it is delivered again.
    session.mail = session.mail.filter(event => !(event.deliveredTurn === turnId && state === 'completed'));
    for (const event of session.mail) {
      if (event.deliveredTurn === turnId) { event.deliveredTurn = undefined; event.redelivered = true; }
    }

    if (session.supervisor) {
      const final = [...session.text.values()].at(-1);
      if (final) session.journal.push(stamp(`${session.mapping.agent.name} final message: ${clip(final, 1500)}`));
      if (session.userWaiting !== undefined && !final) session.journal.push(stamp(`the user's message of ${clock(session.userWaiting)} got no reply in this turn`));
      session.journal.push(stamp(`turn ended: ${state}${error ? ` (${clip(errorData(error).message, 200)})` : ''}`));
      // Answering the supervisor is not reviewed again, or the two would loop. A turn the user
      // stopped is the user's choice, not main's mistake: a review would only send mail that an
      // interrupted root never wakes for, and its tree would stay busy.
      if (session.supervisorWake || (session.userStopped && state === 'canceled')) session.journal.length = 0;
      else review(sessionId);
    }
    session.userStopped = false;
    if (session.role === 'supervisor' && session.parent && sessions.get(session.parent)?.reviewPending) review(session.parent);
    if (!session.parent) void showTasks(sessionId, session);
    if (!session.parent && session.role !== 'supervisor') queueMicrotask(() => compactAtBoundary(sessionId, session, state));

    // An assignment a limit or a pause stopped waits, open, to continue instead of ending.
    if (session.parkReason && state !== 'completed') {
      park(sessionId, session);
      return;
    }
    session.parkReason = undefined;
    session.parkPause = undefined;

    // A requester is not done while its assignments run or mail awaits it.
    if (state === 'completed' && (session.assignments.size || hasActiveMail(session))) {
      queueMicrotask(() => deliver(sessionId, session));
      return;
    }

    session.settle?.(state, error);
  }

  /**
   * A native user message as ALP sent it: Codex keeps the clientUserMessageId ALP gave it as
   * `clientId`, and the parts of the input startPrompt built (CATALOG first, then the task digest,
   * an interrupted turn's words, the prompt, its images and mail). The message is the prompt part
   * alone, and its origin comes from its id: ALP's own (mail, briefs, resumes) never title a root.
   * A message ALP sent without an id (an older Codex) has no origin anyone can trust; one ALP did not
   * build (a thread started outside ALP) is the user's.
   */
  function nativePrompt(item: any, session: Session): { text: string; clientMessageId?: string; origin?: TurnOrigin; attachments?: ReturnType<typeof attachmentsOf> } {
    const parts: string[] = (item.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => String(c.text ?? ''));
    const clientMessageId = typeof item.clientId === 'string' && item.clientId ? item.clientId : undefined;
    // Mail steered into a running turn is sent alone, without CATALOG.
    if (!parts[0]?.startsWith(CATALOG)) return { text: parts.join('\n'), ...(clientMessageId ? { clientMessageId } : {}), origin: clientMessageId ? promptOrigin(clientMessageId, session) : parts[0]?.startsWith(MAIL_HEADER) ? 'wake' : 'user' };
    const origin = clientMessageId ? promptOrigin(clientMessageId, session) : undefined;
    const ids = { ...(clientMessageId ? { clientMessageId } : {}), ...(origin ? { origin } : {}) };
    const layout = inputLayoutOf(parts[0]);
    const attached = attachmentsOf(parts[0]);
    // The prompt where CATALOG says it is. Every other part ALP sends has words, so a part missing
    // is an empty prompt (an image alone) the runtime left out: its text is none, never a neighbour's.
    if (layout) return { text: parts.length === layout.textParts ? parts[layout.prompt] ?? '' : '', ...ids, ...(attached.length ? { attachments: attached } : {}) };
    // A message from before CATALOG named its layout: read by what its parts begin with.
    const rest = parts.slice(1);
    // Mail delivered with a prompt follows it; a mail wake's prompt is mail itself, after the task digest.
    if (!clientMessageId?.startsWith('alp-wake-') && rest.length > 1 && rest.at(-1)!.startsWith(MAIL_HEADER)) rest.pop();
    return { text: rest.at(-1) ?? '', ...ids };
  }

  function nativeItem(
    sessionId: string,
    session: Session,
    item: any,
    done = false,
  ) {
    if (item.type === 'agentMessage') {
      // The first words main shows after the user wrote: how long the user waited.
      if (session.userWaiting !== undefined && String(item.text ?? '').trim()) {
        if (session.supervisor) session.journal.push(stamp(`${session.mapping.agent.name} answered the user ${span(Date.now() - session.userWaiting)} after their message of ${clock(session.userWaiting)}`));
        session.userWaiting = undefined;
      }
      session.text.set(item.id, item.text);
      emit(sessionId, { type: 'item', item: { kind: 'assistant_message', id: item.id, text: item.text } });
      return;
    }

    if (item.type === 'userMessage') {
      const { text, clientMessageId, origin, attachments } = nativePrompt(item, session);
      const images = (item.content ?? []).filter((c: any) => c.type === 'image' || c.type === 'localImage').length;
      emit(sessionId, { type: 'item', item: { kind: 'user_message', id: item.id, text, ...(clientMessageId ? { clientMessageId } : {}), ...(origin ? { origin } : {}), ...(images ? { images } : {}), ...(attachments ? { attachments } : {}) } });
      return;
    }

    if (item.type === 'dynamicToolCall') {
      const status =
        item.status === 'inProgress'
          ? 'running'
          : item.success === false || item.status === 'failed'
            ? 'failed'
            : 'completed';
      if (session.supervisor && status !== 'running' && item.tool !== 'alp_delegate') {
        session.journal.push(stamp(`${session.mapping.agent.name} tool ${item.tool} ${status}: ${clip(JSON.stringify(item.arguments ?? {}))}`));
      }

      emit(sessionId, {
        type: 'item',
        item: {
          kind: 'tool_call',
          id: item.id,
          callId: item.callId ?? item.id,
          name: item.tool,
          status,
          ...(status === 'failed' ? { error: item.tool === 'alp_delegate' ? 'Delegation failed' : 'Tool call failed' } : {}),
          detail: {
            type: 'unknown',
            input: item.arguments ?? {},
            output: item.contentItems ?? null,
          },
        },
      });
      return;
    }

    if (item.type === 'commandExecution') {
      const status =
        item.status === 'inProgress'
          ? 'running'
          : item.status === 'completed'
            ? 'completed'
            : 'failed';
      if (session.supervisor && status !== 'running') {
        session.journal.push(stamp(`${session.mapping.agent.name} shell ${status}${item.exitCode != null ? ` (exit ${item.exitCode})` : ''}: ${clip(String(item.command ?? ''))}`));
      }

      // A transport that knows the tool attaches its typed detail; the command stays as it was.
      // The protocol's bounds hold here for every transport (boundDetail passes unknown as it is).
      const typed = item.detail && typeof item.detail === 'object' && item.detail.type !== 'shell' ? boundDetail(item.detail) : undefined;
      emit(sessionId, {
        type: 'item',
        item: {
          kind: 'tool_call',
          id: item.id,
          callId: item.id,
          name: typed ? String(item.tool || 'tool') : 'shell',
          status,
          ...(status === 'failed' ? { error: typed ? toolError(item.error) : 'Command failed' } : {}),
          detail: typed ?? (item.detail?.type === 'shell' ? item.detail : {
            type: 'shell',
            command: item.command,
            cwd: item.cwd,
            output: item.aggregatedOutput ?? '',
            exitCode: item.exitCode,
          }),
        },
      });
      return;
    }

    // Codex's own file changes, web searches, MCP calls and sub-agents (ALPD §4.2).
    const call = codexToolCall(item, done);
    if (call) {
      emit(sessionId, {
        type: 'item',
        item: { kind: 'tool_call', id: item.id, callId: item.id, name: call.name, status: call.status, ...(call.error ? { error: call.error } : {}), detail: call.detail },
      });
    }
  }

  function notification(
    sessionId: string,
    session: Session,
    method: string,
    params: any,
  ) {
    if (session.closed) return;
    // What the runtime says it runs with; the run log keeps it beside the configured model (§12.9).
    if (method === 'alp/nativeModel') {
      if (typeof params?.model === 'string') runLog(rootOf(sessionId), { event: 'session.native_model', sessionId, agent: session.mapping.agent.name, configured: session.mapping.model, model: params.model.slice(0, 200) });
      return;
    }

    touch(sessionId, session);

    if (session.pending) {
      session.buffered.push([method, params]);
      return;
    }

    if (params?.threadId && params.threadId !== session.threadId) return;

    if (method === 'item/agentMessage/delta') {
      const text =
        (session.text.get(params.itemId) ?? '') + params.delta;

      session.text.set(params.itemId, text);
      emit(sessionId, { type: 'item', item: { kind: 'assistant_message', id: params.itemId, text } });
      return;
    }

    if ((method === 'item/completed' || method === 'item/started') && params.item?.type === 'contextCompaction') {
      compaction(sessionId, session, params.item, method === 'item/completed');
      return;
    }

    if (method === 'item/completed' || method === 'item/started') {
      if (method === 'item/completed') session.progressAt = Date.now();
      if (params.item?.type !== 'userMessage') {
        nativeItem(sessionId, session, params.item, method === 'item/completed');
      }
      if (method === 'item/started' && params.item?.type === 'commandExecution') watchCopy(sessionId, session, params.item);
      if (method === 'item/started' && params.item) skillUse(sessionId, session, params.item);
      return;
    }

    // A running tool call that learned more, such as an ACP call's path or diff.
    if (method === 'item/updated') {
      if (params.item?.type === 'commandExecution' && params.item.status === 'inProgress') nativeItem(sessionId, session, params.item);
      return;
    }

    if (method === 'account/rateLimits/updated') {
      usageReport(session, params);
      return;
    }

    if (method === 'thread/tokenUsage/updated') {
      const usage = sessionUsage(session.usage, params?.tokenUsage);
      if (usage) {
        session.usage = usage;
        emit(sessionId, { type: 'usage', usage });
      }
      contextReport(sessionId, session, params?.tokenUsage);
      return;
    }

    // A turn the native runtime started by itself (ALPD §56): ALP follows it as its own, so
    // its tools work and its end wakes, reviews and settles as any turn's does.
    if (method === 'turn/started') {
      if (!session.active && params.turn?.id) {
        session.active = params.turn.id;
        emit(sessionId, { type: 'turn.started', turnId: params.turn.id, origin: 'runtime' });
      }
      return;
    }

    if (
      method === 'turn/completed' &&
      params.turn.id === session.active
    ) {
      const state =
        params.turn.status === 'completed'
          ? 'completed'
          : params.turn.status === 'interrupted'
            ? 'canceled'
            : 'failed';

      // A usage limit pauses its runtime; an assignment it stopped is parked to continue later.
      if (state === 'failed' && LIMIT_ERRORS.includes(params.turn.error?.codexErrorInfo)) {
        if (session.role !== 'supervisor') {
          session.parkReason = `the ${label(session.runtimeKind)} usage limit was reached`;
          session.parkPause = { scope: paused.all ? 'all' : session.runtimeKind };
        }
        void limitReached(session, params.turn.error);
      }

      terminal(
        sessionId,
        session,
        state,
        params.turn.error?.message,
      );
    }
  }

  // Failure callbacks and an opening call's catch can both retire the same record.
  // Keep the cleanup with that incarnation, even after its id has been reused.
  const sessionClosures = new WeakMap<Session, Promise<void>>();
  const openedSessions = new WeakSet<Session>();
  const assignmentSessions = new WeakMap<Assignment, Session>();
  function closeSession(sessionId: string, session = sessions.get(sessionId), notify = true): Promise<void> {
    if (!session) return Promise.resolve();
    const closing = sessionClosures.get(session);
    if (closing) return closing;
    if (session.closed) return Promise.resolve();

    session.closed = true;
    const current = sessions.get(sessionId) === session;
    const opened = openedSessions.has(session);
    const parent = session.parent ? sessions.get(session.parent) : undefined;
    const descendants = current ? [...session.children, ...(session.supervisor ? [session.supervisor] : [])]
      .map(id => [id, sessions.get(id)] as const).filter((entry): entry is readonly [string, Session] => !!entry[1]) : [];
    if (current) {
      cancelQuestions(sessionId);
      approvalLedger.delete(sessionId);
      releaseClaims(sessionId, session.mapping.agent.projectRoot);
      // terminal also touches questions and parent bookkeeping by id. Do it before
      // yielding, while this is still the record registered under that id.
      terminal(sessionId, session, 'canceled');
      session.settle?.('canceled', 'Session closed');
    }

    const cleanup = (async () => {
      await Promise.all(
        descendants.map(([id, child]) => closeSession(id, child)),
      );
      await session.runtime.close();

      // Copies of assignments that did not finish hold nothing to keep.
      for (const assignment of session.assignments.values()) if (assignment.copy && !assignment.finished) await removeCopy(assignment.copy).catch(() => {});

      for (const [assignmentId, { worktree }] of session.worktrees) {
        await removeWorktree(worktree).catch(() => {});
        runLog(rootOf(sessionId), { event: 'worktree.kept', assignmentId, branch: worktree.branch });
      }
      session.worktrees.clear();

      // Every id-based side effect belongs to this incarnation, including the
      // parent's membership and the event that tells viewers it is no longer live.
      if (sessions.get(sessionId) !== session) return;
      sessions.delete(sessionId);
      if (session.parent && parent && sessions.get(session.parent) === parent) {
        parent.children.delete(sessionId);
        if (parent.supervisor === sessionId) parent.supervisor = undefined;
      }

      // An opening failure has no live incarnation to close. Its failure callback
      // reports session.failed; an ordinary startup rejection is the open error.
      if (notify && opened) emit(sessionId, { type: 'session.closed' });
    })();
    sessionClosures.set(session, cleanup);
    return cleanup;
  }

  let runLogWrites = Promise.resolve();

  /** A session's root, also for an assignment already closed. */
  const rootFor = (sessionId: string, session: Session) => sessions.has(sessionId) ? rootOf(sessionId) : session.parent ? rootOf(session.parent) : sessionId;

  /** Answers about a project's hooks, one question per root tree and project (ALPD §45). */
  const trustAsks = new Map<string, Promise<boolean>>();

  /**
   * Whether a project's hooks may run: the user trusts the workspace once, and ALP
   * records it in $ALP_HOME/state/trust.json; library hooks never ask.
   */
  async function hooksTrusted(sessionId: string, session: Session) {
    const project = session.mapping.agent.projectRoot;
    if (options.libraryDir && await isTrusted(options.libraryDir, project)) return true;
    const key = `${rootFor(sessionId, session)}\0${project}`;
    const pending = trustAsks.get(key);
    if (pending) return pending;
    const asked = (async () => {
      const names = session.mapping.hooks.filter(hook => hook.project).map(hook => `${hook.name} (${hook.event}: ${clip(hook.command, 120)})`);
      const say = wordsFor(session);
      const assignment = session.parent ? sessions.get(session.parent)?.assignments.get(sessionId) : undefined;
      const result = await askUser(sessionId, session, assignment, say.trust(project, names.join('; ')), [say.trustYes, say.trustNo]) as { contentItems: Array<{ text: string }> };
      let value: any;
      try { value = JSON.parse(result.contentItems[0].text); } catch { value = {}; }
      const answer = String(value.answer ?? '').trim().toLowerCase();
      const trusted = value.status === 'answered' && (CHOICES.trust.includes(answer) || APPROVALS.includes(answer));
      if (trusted && options.libraryDir) await trustProject(options.libraryDir, project).catch(() => {});
      runLog(rootFor(sessionId, session), { event: 'hook.trust', project, trusted, ...(value.status !== 'answered' ? { outcome: value.status ?? 'canceled' } : {}) });
      // A question its turn's end cancelled is asked again at the next hook.
      if (value.status !== 'answered' && value.status !== 'dismissed') trustAsks.delete(key);
      return trusted;
    })();
    trustAsks.set(key, asked);
    return asked;
  }

  /**
   * Runs a session's hooks for an event (ALPD §45). Hooks that cannot block run in the
   * background; blocking ones run in turn, and the first lines of a failed one's output
   * come back as the reason the action is refused.
   */
  async function runHooks(sessionId: string, session: Session, event: string, details: Record<string, unknown> = {}, taskId?: string): Promise<string | undefined> {
    const candidates = session.mapping.hooks.filter(hook => hook.event === event);
    if (!candidates.length) return undefined;
    const project = session.mapping.agent.projectRoot;
    const agent = session.mapping.agent.name;
    const labels: string[] = taskId && candidates.some(hook => hook.match?.label) ? (await getTask(project, taskId).catch(() => undefined))?.labels ?? [] : [];
    const hooks = candidates.filter(hook => hookMatches(hook, { agent, labels }));
    if (!hooks.length) return undefined;
    const rootId = rootFor(sessionId, session);
    const payload = { event, project, session: sessionId, agent, ...(session.parentAgent ? { parentAgent: session.parentAgent } : {}), team: session.mapping.workflow.mode, ...(taskId ? { task: taskId } : {}), ...details };
    const env = { ALP_EVENT: event, ALP_SESSION: sessionId, ALP_AGENT: agent, ALP_TASK: taskId ?? '', ALP_PROJECT: project };
    const one = async (hook: typeof hooks[number]) => {
      if (hook.project && !(await hooksTrusted(sessionId, session))) {
        runLog(rootId, { event: 'hook', on: event, hook: hook.name, agent, sessionId, skipped: 'untrusted' });
        return undefined;
      }
      try {
        const result = await runHook(hook, payload, { cwd: session.mapping.workdir, env });
        const failed = result.exitCode !== 0 || result.timedOut;
        const blocked = !!hook.blocking && failed;
        const output = (result.stderr.trim() || result.stdout.trim()).split('\n').slice(-20).join('\n');
        runLog(rootId, { event: 'hook', on: event, hook: hook.name, agent, sessionId, exitCode: result.exitCode, durationMs: result.durationMs, ...(result.timedOut ? { timedOut: true } : {}), ...(blocked ? { blocked: true } : {}), ...(failed && output ? { output: clip(output, 400) } : {}) });
        if (!blocked) return undefined;
        return `${hook.name} ${result.timedOut ? `timed out after ${hook.timeoutSec ?? 60} s` : `exited ${result.exitCode ?? result.signal}`}${output ? `:\n${output.slice(0, 4000)}` : ''}`;
      } catch (error) {
        runLog(rootId, { event: 'hook', on: event, hook: hook.name, agent, sessionId, error: errorData(error).message, ...(hook.blocking ? { blocked: true } : {}) });
        return hook.blocking ? `${hook.name} could not run: ${errorData(error).message}` : undefined;
      }
    };
    for (const hook of hooks.filter(hook => !hook.blocking)) void one(hook);
    const reasons: string[] = [];
    for (const hook of hooks.filter(hook => hook.blocking)) {
      const reason = await one(hook);
      if (reason) reasons.push(reason);
    }
    return reasons.length ? reasons.join('\n\n') : undefined;
  }

  /** Best effort: an unwritable log never blocks or fails delegation. */
  function runLog(rootId: string, entry: Record<string, unknown>) {
    record(rootId, entry);
    const directory = options.runLogDir;
    if (!directory) return;
    const file = path.join(directory, `${rootId.replace(/[^\w.-]/g, '_')}.jsonl`);
    const line = JSON.stringify({ ts: new Date().toISOString(), rootSessionId: rootId, ...entry }) + '\n';
    runLogWrites = runLogWrites
      .then(() => mkdir(directory, { recursive: true, mode: 0o700 }))
      .then(async () => {
        const handle = await open(file, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
        try {
          const info = await handle.stat();
          if (!info.isFile() || (process.platform !== 'win32' && (info.uid !== process.getuid?.() || (info.mode & 0o077)))) return;
          await handle.appendFile(line);
        } finally { await handle.close(); }
      })
      .catch(() => {});
  }

  const silentForMs = options.silentForMs ?? 600_000;
  const checkInMs = options.checkInMs ?? 600_000;
  const askTimeoutMs = options.askTimeoutMs ?? 900_000;
  const userAskTimeoutMs = options.userAskTimeoutMs ?? 1_800_000;
  /** Project boards by project root, loaded from boardDir on first use. */
  const boards = new Map<string, Promise<Pin[]>>();
  /** The same boards once loaded, for synchronous status. */
  const loadedBoards = new Map<string, Pin[]>();
  const userQuestions = new Map<string, { question: UserQuestion; persistent?: boolean; /** From alp_ask: the user's words in the chat end it (#116). */ asked?: boolean; /** A card mirroring a human gate (t-ccac). */ gate?: { rev: number; deciding: boolean; decide: (reply: { text?: string; dismiss?: boolean; reason?: string; channel?: 'paseo' | 'web' }) => Promise<void> }; settle: (outcome: 'answered' | 'dismissed' | 'timeout' | 'canceled', answer?: string, reason?: string, result?: unknown) => void }>();
  let mailSequence = 0;
  let watchdog: NodeJS.Timeout | undefined;

  /**
   * Codex lets a command write the directory it runs in, so a session in a copy
   * could still write the requester's tree by running there. ALP cannot stop it in
   * time; it logs it and tells the requester in the assignment's result.
   */
  function watchCopy(sessionId: string, session: Session, item: { command?: string; cwd?: string }) {
    if (!session.mapping.copy || typeof item.cwd !== 'string' || !session.parent) return;
    const assignment = sessions.get(session.parent)?.assignments.get(sessionId);
    if (!assignment?.copy) return;
    // Paths may differ by symlinks (/var and /private/var on macOS).
    const real = (target: string) => { try { return realpathSync(target); } catch { return path.resolve(target); } };
    const cwd = real(item.cwd);
    const within = (root: string) => { const relative = path.relative(root, cwd); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); };
    if (within(real(assignment.copy.path)) || !within(real(assignment.copy.checkout))) return;
    const command = unwrapShell(String(item.command ?? '')).slice(0, 300);
    (assignment.escapes ??= []).push(`${command} (in ${cwd})`);
    runLog(rootOf(sessionId), { event: 'copy.escape', assignmentId: sessionId, agent: session.mapping.agent.name, command, cwd });
  }

  /**
   * Answers Codex when it asks to run a command or change files: a deny rule
   * declines, an ask rule asks the user, an allow rule accepts, and otherwise full
   * access accepts and a profile with beyondMode ask asks the user.
   */
  async function approve(sessionId: string, session: Session, method: string, params: any) {
    if (method !== 'item/commandExecution/requestApproval' && method !== 'item/fileChange/requestApproval') throw new Error('Unsupported runtime request');
    const profile = session.mapping.permissions;
    const full = session.mapping.mode === 'full-access';
    const command = method === 'item/commandExecution/requestApproval' && params?.kind !== 'writeStdin' && !params?.networkApprovalContext && typeof params?.command === 'string' ? params.command : undefined;
    const rule = command !== undefined && profile ? commandDecision(profile, command) : undefined;
    const log = (decision: string, extra: Record<string, unknown> = {}) => runLog(rootOf(sessionId), {
      event: 'permission', agent: session.mapping.agent.name, sessionId,
      request: command !== undefined ? 'command' : method === 'item/fileChange/requestApproval' ? 'file change' : 'other',
      ...(command !== undefined ? { command: command.slice(0, 500) } : {}),
      decision, ...(rule ? { rule } : {}), ...(profile ? { profile: profile.name } : {}), ...extra,
    });
    if (rule === 'deny' || rule === 'allow' || (rule === undefined && (full || profile?.beyondMode !== 'ask'))) {
      const decision = rule === 'deny' ? 'decline' : rule === 'allow' || full ? 'accept' : 'decline';
      log(decision);
      return { decision };
    }
    // Codex proposes a command prefix to allow; else the exact command.
    const prefix = Array.isArray(params?.proposedExecpolicyAmendment) && params.proposedExecpolicyAmendment.every((token: unknown) => typeof token === 'string') ? params.proposedExecpolicyAmendment.join(' ') : undefined;
    const exact = command !== undefined ? unwrapShell(command) : undefined;
    const always = rule === undefined && (prefix || exact) && !(prefix ?? exact)!.includes(')') ? (prefix ? `Bash(${prefix} *)` : `Bash(${exact})`) : undefined;
    const what = command !== undefined ? `run \`${unwrapShell(command).slice(0, 400)}\`${params?.reason ? ` (${String(params.reason).slice(0, 200)})` : ''}` : `change files${params?.grantRoot ? ` under ${params.grantRoot}` : ''}${params?.reason ? ` (${String(params.reason).slice(0, 200)})` : ''}`;
    const answer = await askPermission(sessionId, session, { what, reason: rule === 'ask' ? 'rule' : 'mode', always, recheck: command });
    log(answer.allow ? 'accept' : 'decline', { asked: true, ...(answer.always ? { always: always } : {}) });
    return { decision: answer.allow ? 'accept' : 'decline' };
  }

  /** Claude asks when an ask rule covers a tool use, or when a read-only mode refuses it and the profile asks beyond its mode. */
  async function claudePermission(sessionId: string, session: Session, request: { tool: string; input: Record<string, unknown>; reason: 'rule' | 'mode'; rule?: string }) {
    const command = request.tool === 'Bash' && typeof request.input?.command === 'string' ? request.input.command : undefined;
    const target = command ?? (typeof request.input?.file_path === 'string' ? request.input.file_path : typeof request.input?.url === 'string' ? request.input.url : undefined);
    const what = `use ${request.tool}${target ? `: \`${String(target).slice(0, 400)}\`` : ''}`;
    const answer = await askPermission(sessionId, session, { what, reason: request.reason, always: request.reason === 'mode' ? request.rule : undefined, recheck: command });
    runLog(rootOf(sessionId), {
      event: 'permission', agent: session.mapping.agent.name, sessionId, request: request.tool, ...(target ? { command: String(target).slice(0, 500) } : {}),
      decision: answer.allow ? 'accept' : 'decline', asked: true, ...(request.reason === 'rule' ? { rule: 'ask' } : {}), ...(answer.always ? { always: request.rule } : {}),
      ...(session.mapping.permissions ? { profile: session.mapping.permissions.name } : {}),
    });
    return answer;
  }

  /**
   * An ACP agent asks before using a tool (ALPD §46): ALP's tools, reading, and what the
   * mode allows run; deny and allow rules hold for commands; an ask rule, or anything
   * beyond the mode when the profile asks beyond it, goes to the user.
   */
  async function acpPermissionRequest(sessionId: string, session: Session, request: AcpPermission) {
    const profile = session.mapping.permissions;
    const decision = acpDecision(request, session.mapping.mode, profile, session.mapping.workdir);
    const log = (result: string, extra: Record<string, unknown> = {}) => runLog(rootOf(sessionId), {
      event: 'permission', agent: session.mapping.agent.name, sessionId, request: request.kind,
      ...(request.command !== undefined ? { command: request.command.slice(0, 500) } : request.title ? { command: request.title.slice(0, 500) } : {}),
      decision: result, ...(profile ? { profile: profile.name } : {}), ...extra,
    });
    if (decision === 'allow') return { allow: true };
    if (decision === 'deny' || (decision === 'mode' && profile?.beyondMode !== 'ask')) {
      log('decline', decision === 'deny' ? { rule: 'deny' } : {});
      return { allow: false };
    }
    const exact = request.command !== undefined ? unwrapShell(request.command) : undefined;
    const always = decision === 'mode' && exact && !exact.includes(')') ? `Bash(${exact})` : undefined;
    const answer = await askPermission(sessionId, session, { what: acpWhat(request), reason: decision, always, recheck: request.command });
    log(answer.allow ? 'accept' : 'decline', { asked: true, ...(decision === 'rule' ? { rule: 'ask' } : {}), ...(answer.always ? { always } : {}) });
    return answer;
  }

  /**
   * Asks the user about one permission, one question per session at a time.
   * "Always allow" adds the rule to the profile in its settings file and to the
   * open sessions that use it; an ask rule offers only once or no.
   */
  function askPermission(sessionId: string, session: Session, request: { what: string; reason: 'rule' | 'mode'; always?: string; recheck?: string }) {
    const run = async (): Promise<{ allow: boolean; always?: boolean; message?: string }> => {
      const profile = session.mapping.permissions;
      // Another question may have allowed it always in the meantime.
      if (request.reason === 'mode' && request.recheck && profile && commandDecision(profile, request.recheck) === 'allow') return { allow: true };
      const say = wordsFor(session);
      const choices = request.always && profile ? [say.allowOnce, say.alwaysAllow, say.deny] : [say.allowOnce, say.deny];
      const body = say.permission(session.mapping.agent.name, request.what, request.reason === 'rule', profile?.name, session.mapping.mode, choices.length === 3 ? request.always : undefined);
      const assignment = session.parent ? sessions.get(session.parent)?.assignments.get(sessionId) : undefined;
      const result = await askUser(sessionId, session, assignment, body, choices) as { contentItems: Array<{ text: string }> };
      let value: any;
      try { value = JSON.parse(result.contentItems[0].text); } catch { value = {}; }
      if (value.status !== 'answered') return { allow: false, message: `The user did not answer (${value.status ?? 'canceled'}); it was not allowed` };
      const answer = String(value.answer).trim();
      const choice = answer.toLowerCase();
      if (CHOICES.alwaysAllow.includes(choice) && choices.length === 3) {
        await addAllowRule(session.mapping.agent.projectRoot, options.libraryDir, profile!.name, request.always!);
        for (const other of sessions.values()) {
          const rules = other.mapping.permissions;
          if (rules?.name === profile!.name && other.mapping.agent.projectRoot === session.mapping.agent.projectRoot && !rules.allow.includes(request.always!)) rules.allow.push(request.always!);
        }
        return { allow: true, always: true };
      }
      if (CHOICES.allowOnce.includes(choice) || APPROVALS.includes(choice)) return { allow: true };
      return { allow: false, message: CHOICES.deny.includes(choice) ? 'The user refused it' : `The user refused it: ${answer}` };
    };
    const next = (session.permissionQueue ?? Promise.resolve()).then(run, run);
    session.permissionQueue = next.catch(() => {});
    return next;
  }

  function rootOf(sessionId: string) {
    let id = sessionId;
    for (let parent: string | undefined = sessions.get(id)?.parent; parent && sessions.has(parent); parent = sessions.get(id)?.parent) id = parent;
    return id;
  }

  function hasActiveMail(session: Session) {
    return session.mail.some(event => !event.deliveredTurn && !event.passive);
  }

  /** Main of a Phở or Cafe tree gets a supervisor, when the host shows child sessions. */
  function supervises(session: Session) {
    return options.supervisor !== false && !session.parent && session.mapping.agent.name === mainOf(session.mapping) && session.mapping.workflow.supervisor && session.delegation;
  }

  /** A root's supervisor is reviewing it, or a review waits to start. */
  function reviewing(session: Session) {
    const supervisor = session.supervisor ? sessions.get(session.supervisor) : undefined;
    return !!supervisor && !supervisor.closed && !!(supervisor.active || supervisor.pending || session.reviewPending);
  }

  /** Notes a run-log entry in a supervised root's journal; the supervisor's own activity is left out. */
  function record(rootId: string, entry: Record<string, any>) {
    const root = sessions.get(rootId);
    const watcher = root?.mapping.team?.supervisor ? root.mapping.team.supervisor.agent : 'supervisor';
    if (!root?.supervisor || entry.from === 'supervisor' || entry.agent === watcher) return;
    const line =
      entry.event === 'assignment.started' ? `${entry.parentAgent} → ${entry.agent} assignment ${entry.assignmentId}${entry.taskId ? ` for task ${entry.taskId}` : ''} (${entry.model}, ${entry.thinking ?? 'default effort'}, ${entry.mode}, ${entry.isolation}${entry.wait ? '' : ', async'}): ${clip(entry.task)}`
      : entry.event === 'assignment.finished' ? `${entry.agent} assignment ${entry.assignmentId} ${entry.status}${entry.handoff ? `, handoff ${entry.handoff.outcome}${entry.handoff.verdict ? `, ${verdictLine(entry.handoff.verdict)}` : ''}: ${clip(entry.handoff.summary)}` : ', no handoff'}${entry.error ? ` (${clip(entry.error, 200)})` : ''}${entry.handoff?.discovered?.length ? `; discovered: ${clip(entry.handoff.discovered.join('; '))}` : ''}`
      : entry.event === 'mail' && entry.kind !== 'result' && entry.kind !== 'board' ? `mail ${entry.kind} from ${entry.from}${entry.replyTo ? ` (reply to ${entry.replyTo})` : ''}: ${clip(entry.body ?? '')}`
      : entry.event === 'human.question' ? `${entry.agent} asked the user: ${clip(entry.body)}`
      : entry.event === 'human.answer' ? `user ${entry.outcome} ${entry.questionId}${entry.answer ? `: ${clip(entry.answer)}` : ''}`
      : entry.event === 'board.pin' ? `${entry.agent} pinned ${entry.kind}${entry.paths ? ` ${entry.paths.join(', ')}` : ''}: ${clip(entry.body)}`
      : entry.event === 'lesson' ? `${entry.agent} recorded a ${entry.scope} lesson: ${clip(entry.lesson)}`
      // Two entries share the name: alp_skill saving one (name, roles), and an agent using one (skill, via), which skillUse journals itself.
      : entry.event === 'skill' && Array.isArray(entry.roles) ? `${entry.agent} saved skill ${entry.name} for ${entry.roles.join(', ')} with the user's approval`
      : entry.event === 'task' ? `${entry.agent} ${TASK_PAST[entry.action] ?? entry.action} task ${entry.id} "${clip(entry.title, 120)}"${entry.status ? ` (now ${entry.status})` : ''}${entry.detail ? `: ${clip(entry.detail)}` : ''}`
      : entry.event === 'epic.landed' ? `${entry.agent} closed ${entry.id} "${clip(entry.title, 120)}": ${entry.tasks} tasks, ${entry.reworked} reworked, ${entry.unverified?.length ?? 0} closed unverified`
      : entry.event === 'recall' ? `${entry.agent} recalled ${entry.recalled} assignment ${entry.assignmentId}: ${clip(entry.question)}`
      : entry.event === 'skill.approval' && !entry.saved ? `skill approval ${entry.approvalId} for ${entry.name}: not saved (${entry.error ?? entry.outcome})`
      : entry.event === 'issue.approval' ? `issue approval ${entry.approvalId} in ${entry.repo}: ${entry.posted ? entry.url : entry.error ?? entry.outcome}`
      : entry.event === 'issue' ? `${entry.action === 'create' ? `opened issue "${clip(entry.title, 200)}"` : `commented on issue #${entry.issue}`} in ${entry.repo} with the user's approval: ${entry.url}`
      : entry.event?.startsWith('worktree.') ? `${entry.event.slice('worktree.'.length)} worktree of ${entry.assignmentId} (${entry.branch})${entry.status ? `: ${entry.status}` : ''}`
      : undefined;
    if (line) root.journal.push(stamp(line));
  }

  /** Whether a journal holds more than the end of a turn that did nothing. */
  const eventful = (journal: string[]) => journal.some(line => !unstamped(line).startsWith('turn ended:'));

  /**
   * Sends a root's journal to its supervisor, or keeps it until the supervisor's
   * current review ends. reviewPending keeps the tree busy until the review starts,
   * so an idle-tree reap cannot close it in between.
   */
  function review(rootId: string) {
    const root = sessions.get(rootId);
    const supervisorId = root?.supervisor;
    const supervisor = supervisorId ? sessions.get(supervisorId) : undefined;
    if (!root || !supervisorId || !supervisor || supervisor.closed) return;
    if (!eventful(root.journal)) {
      root.journal.length = 0;
      return;
    }
    root.reviewPending = true;
    // A running review takes the next digest when it ends; a queued one takes this journal too.
    if (supervisor.active || supervisor.pending || root.reviewQueued) return;
    root.reviewQueued = true;
    void enqueue(async () => {
      root.reviewQueued = false;
      if (supervisor.closed) {
        root.reviewPending = false;
        return;
      }
      if (supervisor.active || supervisor.pending) return;
      const lines = root.journal.splice(0);
      root.reviewPending = false;
      if (!eventful(lines)) return;
      let size = 0;
      const kept: string[] = [];
      for (const line of lines) {
        if (size + line.length > DIGEST_CHARS) {
          kept.push(`… ${lines.length - kept.length} more events left out; read the run log or files if they matter.`);
          break;
        }
        kept.push(`- ${line}`);
        size += line.length + 3;
      }
      const agent = root.mapping.agent.name;
      const text = `Digest of ${agent}'s turn (profile ${root.mapping.workflow.mode}), oldest first, each line with its local time:\n${kept.join('\n')}\n\n` +
        `${agent}'s session: ${root.runtimeKind}:${root.mapping.model}, thinking ${root.mapping.thinking ?? 'default'}, mode ${root.mapping.mode}. Judge ${agent} by this session and its own instructions; your system prompt describes your session (your model, attribution lines, tools), not ${agent}'s.\n\n` +
        `Review the process against ALP.md, ${agent}'s AGENT.md and the recorded lessons. Ask ${agent} about each mistake with one alp_send to: "parent", kind note, or send nothing when the process was sound.`;
      await startPrompt(supervisorId, { clientMessageId: `alp-review-${randomUUID()}`, delivery: 'auto', content: [{ type: 'text', text }] }, 'assignment');
    }).catch(error => runLog(rootId, { event: 'supervisor.failed', error: errorData(error).message }));
  }

  /** Starts a root's supervisor beside it; a supervisor that cannot start never fails its root. */
  async function openSupervisor(rootId: string) {
    const root = sessions.get(rootId);
    if (!root || root.closed || root.supervisor || root.parent) return;
    const id = `alp-supervisor-${randomUUID()}`;
    childContexts.set(id, { parent: rootId, callId: `supervisor-${rootId}`, graph: {}, workflow: root.mapping.workflow, ancestry: [...root.ancestry, 'supervisor'], role: 'supervisor' });
    const { restore: _restore, ...inherited } = root.spec;
    // The team names the supervisor agent and what it runs on.
    const watcher = root.mapping.team?.supervisor || { agent: 'supervisor' };
    try {
      const snapshot = await openSession(id, { ...inherited, persist: false, agent: watcher.agent, model: watcher.model, thinking: watcher.thinking, mode: 'read-only', workflow: root.mapping.workflow.mode }, 'skip', root.delegation);
      if (root.closed) await closeSession(id);
      else {
        root.supervisor = id;
        runLog(rootId, { event: 'supervisor.started', sessionId: id, model: `${snapshot.runtime}:${snapshot.model}` });
      }
    } catch (error) {
      runLog(rootId, { event: 'supervisor.failed', error: errorData(error).message });
    } finally {
      childContexts.delete(id);
    }
  }

  const lessonWrites = new Map<string, Promise<unknown>>();

  async function lessonTool(sessionId: string, session: Session, args: unknown) {
    if (!plainObject(args, ['scope', 'lesson']) || !['project', 'user'].includes(args.scope) || typeof args.lesson !== 'string' || !args.lesson.trim() || args.lesson.length > LESSON_CHARS) {
      return toolResult(false, { error: `A lesson needs scope (project or user) and one rule of at most ${LESSON_CHARS} characters` });
    }
    if (args.scope === 'user' && !options.libraryDir) return toolResult(false, { error: 'This host keeps no user lessons; record it with scope project' });
    const file = args.scope === 'user' ? path.join(options.libraryDir!, LESSONS_FILE) : path.join(session.mapping.agent.projectRoot, '.alp', LESSONS_FILE);
    const line = `- ${new Date().toISOString().slice(0, 10)}: ${args.lesson.replace(/\s+/g, ' ').trim()}\n`;
    const header = '# ALP lessons\n\nRules main recorded after supervisor reviews. Main follows them in every session; edit or delete them freely.\n\n';
    const write = (lessonWrites.get(file) ?? Promise.resolve()).catch(() => {}).then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const existing = await readFile(file, 'utf8').catch(() => undefined);
      await appendFile(file, existing === undefined ? header + line : line);
    });
    lessonWrites.set(file, write);
    try {
      await write;
    } catch (error) {
      return toolResult(false, { error: errorData(error).message });
    }
    runLog(rootOf(sessionId), { event: 'lesson', scope: args.scope, agent: session.mapping.agent.name, lesson: args.lesson });
    return toolResult(true, { recorded: true, scope: args.scope, file });
  }

  /** alp_task: main changes the task graph; other roles read it (taskActions). */
  async function taskToolCall(sessionId: string, session: Session, args: unknown) {
    const allowed = taskActions(session.mapping, session.parentAgent, session.role);
    if (!plainObject(args, ['action', ...Object.values(TASK_FIELDS).flat()]) || !TASK_ACTIONS.includes(args.action)) {
      return toolResult(false, { error: `action must be one of ${allowed.join(', ')}` });
    }
    const action = args.action as TaskAction;
    if (!allowed.includes(action)) {
      return toolResult(false, { error: allowed.includes('create') ? `Unknown action ${action}` : `Only main and the user change tasks; you may ${allowed.join(', ')}. Report work you find to your requester.` });
    }
    const extra = Object.keys(args).filter(key => key !== 'action' && !TASK_FIELDS[action].includes(key));
    if (extra.length) return toolResult(false, { error: `${action} does not take ${extra.join(', ')}` });
    if (!['create', 'list', 'ready', 'pour', 'formulas'].includes(action) && typeof args.id !== 'string') return toolResult(false, { error: `${action} needs id` });
    if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1)) return toolResult(false, { error: 'limit must be a positive integer' });
    const project = session.mapping.agent.projectRoot;
    const by = session.mapping.agent.name;
    const limit = Math.min(args.limit ?? 20, 100);
    try {
      if (action === 'formulas') {
        const found = await listFormulas(project, options.libraryDir, { toml });
        return toolResult(true, {
          formulas: found.map(entry => entry.formula
            ? { name: entry.name, ...(entry.formula.description ? { description: entry.formula.description } : {}), vars: entry.formula.vars, steps: entry.formula.steps.map(step => `${step.id}${step.type === 'human' ? ' (the user)' : ''}: ${step.title}`) }
            : { name: entry.name, error: entry.error }),
          searched: formulaDirs(project, options.libraryDir),
        });
      }
      if (action === 'show' || action === 'list' || action === 'ready') {
        const { tasks, errors } = await loadTasks(project);
        const warnings = errors.length ? { unreadable: errors } : {};
        if (action === 'show') {
          const task = tasks.find(candidate => candidate.id === args.id);
          if (!task) return toolResult(false, { error: `No task ${args.id}` });
          const blockers = task.status === 'closed' ? [] : blockersOf(task, tasks);
          return toolResult(true, { task, ...(blockers.length ? { openBlockers: blockers } : {}), children: childrenOf(task.id, tasks).map(child => summarize(child, tasks)), ...warnings });
        }
        const rows = action === 'ready' ? readyTasks(tasks) : listTasks(tasks, { status: args.status, label: args.label });
        return toolResult(true, { tasks: rows.slice(0, limit).map(task => summarize(task, tasks)), ...(rows.length > limit ? { more: rows.length - limit } : {}), ...warnings });
      }
      const { action: _action, id, note, reason, summary, unverified, add, remove, ...input } = args;
      if (action === 'pour' && (typeof input.formula !== 'string' || (input.vars !== undefined && (!input.vars || typeof input.vars !== 'object' || Array.isArray(input.vars) || !Object.values(input.vars).every(value => typeof value === 'string'))))) {
        return toolResult(false, { error: 'pour needs formula, and vars as an object of text values' });
      }
      const { kind, until, ref, gate, options: gateChoices, formula: _formula, vars: _vars, ...fields } = input;
      if (action === 'clear') {
        const current = (await loadTasks(project)).tasks.find(candidate => candidate.id === id);
        if (current?.gates.find(entry => entry.id === gate)?.kind === 'human') return toolResult(false, { error: 'Only the user clears a human gate; ask them, and they approve it with alp task gate clear or in Paseo' });
      }
      let poured: Awaited<ReturnType<typeof pourFormula>> | undefined;
      // A blocking task.close hook can refuse the close; its output is the reason.
      const hookedClose = async (id: string) => {
        const refused = await runHooks(sessionId, session, 'task.close', { reason, ...(summary ? { summary } : {}) }, id);
        if (refused) throw new Error(`A task.close hook refused to close ${id}: ${refused}`);
        return closeTask(project, id, { reason, summary, unverified }, by);
      };
      const task =
        action === 'create' ? await createTask(project, fields as any, by)
        : action === 'update' ? await updateTask(project, id, { ...fields, note }, by)
        : action === 'pour' ? (poured = await pourFormula(project, (await findFormula(project, options.libraryDir, input.formula, { toml })).formula, input.vars, by, input.parent ? { parent: input.parent } : {})).epic
        : action === 'gate' ? await addGate(project, id, { kind, note, until, ref, ...(gateChoices !== undefined ? { options: gateChoices } : {}) }, by)
        : action === 'clear' ? await resolveGate(project, id, gate, { by, note })
        : action === 'link' ? await linkTask(project, id, { add, remove }, by)
        : action === 'start' ? await startTask(project, id, { agent: by, session: sessionId }, by)
        : action === 'close' ? await hookedClose(id)
        : await reopenTask(project, id, { note }, by);
      touchTask(rootOf(sessionId), task.id);
      if (action === 'gate' && kind === 'human') void syncGates(project);
      runLog(rootOf(sessionId), { event: 'task', action, agent: by, id: task.id, title: task.title, status: task.status, ...(summary ?? note ? { detail: summary ?? note } : {}) });
      const { tasks } = await loadTasks(project);
      const landed: Record<string, unknown> = {};
      if (action === 'close') {
        // Closing an epic reports what it came to, to main and to the user.
        if (tasks.some(entry => entry.parent === task.id)) {
          const report = epicReport(task.id, tasks);
          landed.report = report.text;
          notice('info', report.text, project);
          runLog(rootOf(sessionId), { event: 'epic.landed', agent: by, id: task.id, title: task.title, tasks: report.tasks, durationMs: report.durationMs, reworked: report.reworked, verification: report.verification, unverified: report.unverified });
        }
        const parent = task.parent ? tasks.find(entry => entry.id === task.parent) : undefined;
        const siblings = parent ? childrenOf(parent.id, tasks) : [];
        if (parent && parent.status !== 'closed' && siblings.every(entry => entry.status === 'closed')) {
          landed.next = `All ${siblings.length} children of ${parent.id} "${parent.title}" are closed; close it with a summary, and ALP reports it to the user`;
        }
      }
      return toolResult(true, { task: summarize(task, tasks), rev: task.rev, ...(poured ? { steps: poured.tasks.map(step => summarize(step, tasks)) } : {}), ...landed });
    } catch (error) {
      return toolResult(false, { error: errorData(error).message });
    }
  }

  const sameDirectory = async (a: string, b: string) => a === b || (await realpath(a).catch(() => a)) === (await realpath(b).catch(() => b));

  /** The recallable assignment named, or the last one that worked on a task of the project. */
  async function findRecall(target: { assignmentId?: string; taskId?: string; projectRoot?: string }) {
    const entries = await recalls.all();
    if (target.assignmentId) return entries.find(entry => entry.assignmentId === target.assignmentId);
    for (const entry of entries.reverse()) {
      if (entry.taskId === target.taskId && (!target.projectRoot || await sameDirectory(entry.project, target.projectRoot))) return entry;
    }
    return undefined;
  }

  /** Forks a finished assignment's native thread read-only, asks it one question, and drops the fork. */
  async function askRecalled(entry: RecallEntry, asker: string, question: string) {
    let cwd = entry.cwd;
    let made = false;
    if (!(await stat(cwd).then(info => info.isDirectory(), () => false))) {
      // Claude finds a session by the directory it ran in; a removed worktree is recreated empty for the fork.
      if (entry.runtime === 'claude') { await mkdir(cwd, { recursive: true }); made = true; } else cwd = entry.project;
    }
    const transport = createTransport(options, entry.runtime, cwd, nativeEnvironment(options));
    let answer = '';
    let timer: NodeJS.Timeout | undefined;
    const done = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`No answer within ${RECALL_TIMEOUT_MS / 1000} s`)), RECALL_TIMEOUT_MS);
      transport.onNotification((method, params) => {
        if (method === 'item/completed' && params?.item?.type === 'agentMessage' && typeof params.item.text === 'string') answer = params.item.text;
        if (method === 'turn/completed') {
          if (params?.turn?.status === 'failed') reject(new Error(params.turn.error?.message ?? 'The recalled session failed to answer'));
          else resolve();
        }
      });
      transport.onFailure(error => reject(error instanceof Error ? error : new Error(String(error))));
    });
    done.catch(() => {});
    transport.onRequest?.(async method =>
      method === 'item/tool/call' ? toolResult(false, { error: 'ALP tools are unavailable in a recall; answer the question' })
      : method === 'item/permission/request' ? { allow: false, message: 'A recall only reads' }
      : { decision: 'decline' });
    try {
      await transport.initialize();
      const forked = await transport.request('thread/fork', {
        threadId: entry.threadId, cwd, model: entry.model, sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true,
        // Codex forks an ephemeral thread only without returning its history, which ALP does not need.
        excludeTurns: true,
        // Claude starts the fork as a new query; Codex keeps the thread's own instructions and tools.
        ...(entry.runtime === 'claude' ? { thinking: entry.thinking ?? 'medium', developerInstructions: `You are the ${entry.agent} agent of ALP, answering questions about an assignment you finished.`, mcpServers: {}, dynamicTools: [] } : {}),
      });
      await transport.request('turn/start', {
        threadId: forked.thread.id,
        input: [{ type: 'text', text: promptSafe(recallPrompt(asker, question)), text_elements: [] }],
        ...(entry.thinking ? { effort: entry.thinking } : {}),
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
      });
      await done;
      return answer.trim();
    } finally {
      clearTimeout(timer);
      await transport.close().catch(() => {});
      if (made) await rm(cwd, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function recallTool(sessionId: string, session: Session, args: unknown) {
    if (!plainObject(args, ['assignmentId', 'taskId', 'question']) || typeof args.question !== 'string' || !args.question.trim() || args.question.length > RECALL_QUESTION_CHARS ||
      (typeof args.assignmentId === 'string') === (typeof args.taskId === 'string')) {
      return toolResult(false, { error: `Pass a question of at most ${RECALL_QUESTION_CHARS} characters, and either assignmentId or taskId` });
    }
    if (args.taskId !== undefined && (session.parent || session.mapping.agent.name !== mainOf(session.mapping))) return toolResult(false, { error: 'Only main recalls by task; pass the assignmentId from the result' });
    if (args.assignmentId !== undefined && sessions.has(args.assignmentId)) return toolResult(false, { error: 'That assignment is still running; ask it with alp_send' });
    const project = session.mapping.agent.projectRoot;
    const entry = await findRecall({ assignmentId: args.assignmentId, taskId: args.taskId, projectRoot: project });
    // A root of the project may ask any assignment made there; any other requester only those it or its assignments started.
    if (!entry || !(await sameDirectory(entry.project, project)) || (session.parent && !entry.requesters.includes(sessionId))) {
      return toolResult(false, { error: `${args.taskId ? `No recallable assignment worked on ${args.taskId}` : `No recallable assignment ${args.assignmentId} of yours`}; assignments stay recallable for ${RECALL_KEEP_MS / 86_400_000} days` });
    }
    try {
      const answer = await askRecalled(entry, session.mapping.agent.name, args.question);
      runLog(rootOf(sessionId), { event: 'recall', agent: session.mapping.agent.name, assignmentId: entry.assignmentId, recalled: entry.agent, question: clip(args.question, 500), answer: clip(answer, 500) });
      return toolResult(true, { assignmentId: entry.assignmentId, agent: entry.agent, ...(entry.taskId ? { taskId: entry.taskId } : {}), finishedAt: entry.finishedAt, answer });
    } catch (error) {
      return toolResult(false, { assignmentId: entry.assignmentId, error: errorData(error).message });
    }
  }

  let forgetting = Promise.resolve();

  /** Deletes the native threads of assignments past their recall time, one transport per runtime. */
  function forgetExpired() {
    forgetting = forgetting.then(async () => {
      const gone = await recalls.expire();
      for (const kind of new Set(gone.map(entry => entry.runtime))) {
        const transport = createTransport(options, kind, os.tmpdir(), nativeEnvironment(options));
        transport.onFailure(() => {});
        try {
          await transport.initialize();
          for (const entry of gone.filter(candidate => candidate.runtime === kind)) await transport.request('thread/delete', { threadId: entry.threadId }).catch(() => {});
        } catch {}
        finally { await transport.close().catch(() => {}); }
      }
    }).catch(() => {});
    return forgetting;
  }

  const RUNTIMES: RuntimeKind[] = ['codex', 'claude', 'antigravity'];
  const LIMIT_ERRORS = ['usageLimitExceeded', 'rateLimitExceeded'];
  const label = (kind: RuntimeKind) => kind === 'claude' ? 'Claude' : kind === 'acp' ? 'ACP agent' : kind === 'antigravity' ? 'Antigravity' : 'Codex';
  const pauseOf = (kind: RuntimeKind) => paused.all ?? paused.runtimes[kind];
  /** Whether a session may not start a turn by itself now: parked, or on a paused runtime. */
  const held = (session: Session) => !!session.parked || !!pauseOf(session.runtimeKind) || (session.lifecycleHolds ?? 0) > 0;
  /** Whether mail may not wake a session now: it is held, or it is a new assignment whose brief has not started. */
  const holdsWake = (session: Session) => held(session) || !!session.awaitingBrief;

  /**
   * Marks a session pending (its native process restarting) with a fresh `acknowledged` that resolves
   * when the returned function clears it. Mail delivered meanwhile waits on that promise; with the old,
   * already resolved one it would retry in a microtask loop and stall the process.
   */
  function beginPending(session: Session) {
    let done!: () => void;
    session.pending = true;
    session.acknowledged = new Promise<void>(resolve => { done = resolve; });
    let cleared = false;
    return () => {
      if (cleared) return;
      cleared = true;
      session.pending = false;
      done();
    };
  }
  const describePause = (pause: Pause, kind?: RuntimeKind) =>
    `${kind ? label(kind) : 'ALP'} is paused (${pause.reason}${pause.by !== 'alpd' ? `, by ${pause.by}` : ''})${pause.resetsAt ? `; the limit resets ${pause.resetsAt}` : ''}`;

  function pauseState(): PauseState {
    return {
      ...(paused.all ? { all: paused.all } : {}),
      runtimes: { ...paused.runtimes },
      parked: [...sessions].filter(([, session]) => session.parked && !session.closed).map(([id, session]) => ({
        assignmentId: id, agent: session.mapping.agent.name, runtime: session.runtimeKind, rootId: rootOf(id), reason: session.parked!.reason, since: new Date(session.parked!.since).toISOString(),
      })),
    };
  }

  function savePauses() {
    const file = options.pauseFile;
    if (!file) return;
    const body = JSON.stringify(paused, null, 2) + '\n';
    pauseWrites = pauseWrites.then(async () => {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
      await writeFile(temporary, body, { mode: 0o600 });
      await moveFile(temporary, file);
    }).catch(() => {});
  }

  /** Tells every open root, or those of one project, and so the user in each viewer. */
  function notice(level: 'info' | 'warning' | 'error', message: string | ((say: Words) => string), project?: string) {
    for (const [id, session] of sessions) {
      if (session.parent || session.closed || (project !== undefined && session.mapping.agent.projectRoot !== project)) continue;
      // ALPD §54: written in the user's language where ALP has the words for it.
      const text = typeof message === 'string' ? message : message(wordsFor(session));
      emit(id, { type: 'item', item: { kind: 'notice', id: `notice-${randomUUID().slice(0, 8)}`, level, text } });
      runLog(id, { event: 'notice', level, text });
    }
  }

  /**
   * While a usage limit pauses a runtime, alpd asks the runtime every LIMIT_CHECK_MS whether
   * the limit lifted (ALPD §58), so a reset, or a limit the user reset early, is seen without
   * anyone resuming it by hand. Pauses the user made are theirs to lift.
   */
  function watchLimits() {
    const needed = !closed && RUNTIMES.some(kind => paused.runtimes[kind]?.by === 'alpd');
    if (needed && !limitWatch) {
      limitWatch = setInterval(() => { for (const kind of RUNTIMES) void checkLimit(kind); }, options.limitCheckMs ?? LIMIT_CHECK_MS);
      limitWatch.unref?.();
    } else if (!needed && limitWatch) {
      clearInterval(limitWatch);
      limitWatch = undefined;
    }
  }

  /** Asks the runtime about the limit that paused it, unless it was asked within `fresh` ms, and resumes it when lifted. */
  function checkLimit(kind: RuntimeKind, fresh = 0): Promise<void> {
    const pause = paused.runtimes[kind];
    const last = limitChecks.get(kind);
    if (!pause || pause.by !== 'alpd' || closed) return Promise.resolve();
    if (last?.running) return last.running;
    if (last && Date.now() - last.at < fresh) return Promise.resolve();
    const running = (async () => {
      const lifted = await limitLifted(kind).catch(() => undefined);
      limitChecks.set(kind, { at: Date.now() });
      if (paused.runtimes[kind] !== pause || closed) return;
      pause.checkedAt = new Date().toISOString();
      // When the runtime cannot say, the reset time it gave earlier decides, a minute after.
      const free = lifted ?? (pause.resetsAt ? Date.parse(pause.resetsAt) + 60_000 <= Date.now() : false);
      if (!free) { savePauses(); return; }
      if (options.autoResume !== false) { resumeRuntime(kind, 'alpd, after the limit lifted'); return; }
      savePauses();
      if (liftTold.has(pause)) return;
      liftTold.add(pause);
      notice('info', say => say.limitLifted(label(kind), kind));
    })();
    limitChecks.set(kind, { at: last?.at ?? 0, running });
    return running;
  }

  /** Reads usage from an open session, or a short-lived process without sending a prompt. */
  async function readUsage(kind: RuntimeKind): Promise<unknown> {
    const open = [...sessions.values()].find(session => !session.closed && !session.pending && session.runtimeKind === kind);
    if (open) return ((await optionalRead(() => open.runtime.orchestrationContext?.() ?? Promise.resolve(undefined), 20_000)) as any)?.usage;
    const transport = createTransport(options, kind, os.tmpdir(), nativeEnvironment(options));
    transport.onFailure(() => {});
    try {
      return await optionalRead(async () => {
        await transport.initialize();
        return ((await transport.orchestrationContext?.()) as any)?.usage;
      }, 20_000);
    } catch {
      return undefined;
    } finally {
      await transport.close().catch(() => {});
    }
  }

  async function limitLifted(kind: RuntimeKind): Promise<boolean | undefined> {
    return usageAllows(await readUsage(kind));
  }

  const usageCache = new Map<'codex' | 'claude', { at: number; pending: boolean; value: Promise<ProviderUsage> }>();
  function cachedUsage(kind: 'codex' | 'claude', refresh = false) {
    const cached = usageCache.get(kind);
    if (cached && (cached.pending || (!refresh && Date.now() - cached.at < 30_000))) return cached.value;
    const value = readUsage(kind).then(usage => providerUsage(kind, usage), () => providerUsage(kind, undefined));
    const entry = { at: Date.now(), pending: true, value };
    usageCache.set(kind, entry);
    void value.then(() => { entry.pending = false; entry.at = Date.now(); });
    return value;
  }

  function pauseRuntime(scope: RuntimeKind | 'all', pause: Pause, now = false) {
    if (scope === 'all') paused.all = pause;
    else { paused.runtimes[scope] = pause; limitChecks.delete(scope); }
    savePauses();
    watchLimits();
    if (now) {
      for (const [id, session] of sessions) {
        if (!session.parent || session.closed || !session.active || session.role === 'supervisor' || (scope !== 'all' && session.runtimeKind !== scope)) continue;
        // A process restart already owns its continuation; this pause must not replace its cause.
        if (session.parkReason && !session.parkPause) continue;
        session.parkReason = `paused by ${pause.by}`;
        session.parkPause = { scope };
        void session.runtime.request('turn/interrupt', { threadId: session.threadId, turnId: session.active }).catch(() => {});
        runLog(rootOf(id), { event: 'assignment.parking', assignmentId: id, agent: session.mapping.agent.name, reason: session.parkReason });
      }
    }
  }

  function resumeRuntime(scope: RuntimeKind | 'all', by: string) {
    if (scope === 'all') paused = { runtimes: {} };
    else delete paused.runtimes[scope];
    savePauses();
    watchLimits();
    const matches = (pause: Session['parkPause']) => pause && (scope === 'all' || pause.scope === scope);
    const continuing = [...sessions.values()].some(session => !session.closed && !pauseOf(session.runtimeKind) && matches(session.parked?.pause));
    const free = RUNTIMES.filter(kind => !pauseOf(kind));
    if (free.length) notice('info', say => say.resumed(scope === 'all' ? 'ALP' : label(scope), by, continuing));
    for (const [id, session] of sessions) {
      if (session.closed || (scope !== 'all' && session.runtimeKind !== scope)) continue;
      if (matches(session.parkPause)) session.parkPause!.resumed = true;
      if (pauseOf(session.runtimeKind)) continue;
      if (session.parked) {
        if (matches(session.parked.pause)) continueParked(id, session);
      } else if (session.wakeHeld) { session.wakeHeld = false; deliver(id, session); }
    }
  }

  /** An assignment whose turn a limit or a pause ended stays open, and its requester learns why. */
  function park(sessionId: string, session: Session) {
    session.parked = { reason: session.parkReason!, since: Date.now(), ...(session.parkPause ? { pause: session.parkPause } : {}) };
    const resumed = session.parkPause?.resumed;
    session.parkPause = undefined;
    const then = session.parkThen;
    session.parkReason = undefined;
    session.parkThen = undefined;
    emit(sessionId, { type: 'session.updated', session: snapshot(sessionId, session) });
    if (resumed) continueParked(sessionId, session);
    const parent = session.parent ? sessions.get(session.parent) : undefined;
    const assignment = parent?.assignments.get(sessionId);
    runLog(rootOf(sessionId), { event: 'assignment.parked', assignmentId: sessionId, agent: session.mapping.agent.name, reason: session.parked.reason });
    if (!parent || !assignment) return;
    emit(session.parent!, { type: 'assignment', assignment: assignmentSnapshot(assignment, 'parked') });
    // One that continues by itself is information; one held until the user resumes needs the requester's decision, so it wakes it.
    if (then) post(session.parent!, { kind: 'note', from: assignment.agent, assignment: sessionId, passive: true, body: `Parked: ${session.parked.reason}. ${then} Wait for it, or start other work.` });
    else post(session.parent!, { kind: 'stalled', from: assignment.agent, assignment: sessionId, body: `Parked: ${session.parked.reason}. ALP continues this assignment where it stopped when ${label(session.runtimeKind)} is resumed (${options.autoResume !== false && (pauseOf(session.runtimeKind)?.by ?? 'alpd') === 'alpd' ? `ALP resumes it as soon as ${label(session.runtimeKind)} says the limit lifted` : 'the user runs alp resume'}). Wait for it, start other work, or stop it with alp_cancel and give the rest to an agent on another runtime (pass model claude:… or codex:…); what it changed stays in your checkout or its worktree.` });
  }

  function continueParked(sessionId: string, session: Session, expected = session.parked) {
    void enqueue(async () => {
      if (session.closed || session.active || session.pending || !session.parked || session.parked !== expected) return;
      // This continuation owns only the captured park. A pause may have arrived while
      // it waited in the queue; retain the actual blocker for a matching later resume.
      if (pauseOf(session.runtimeKind)) {
        session.parked.pause = { scope: paused.all ? 'all' : session.runtimeKind };
        return;
      }
      // A lifecycle operation (a fork or rewind reading the conversation) holds the session: the work stays
      // parked and continues when the last hold releases, as held mail does.
      if (session.lifecycleHolds) { session.resumeHeld = session.parked; return; }
      const parked = session.parked;
      const { reason, prompt } = parked;
      session.parked = undefined;
      session.wakeHeld = false;
      session.lastActivity = Date.now();
      const parent = session.parent ? sessions.get(session.parent) : undefined;
      const assignment = parent?.assignments.get(sessionId);
      runLog(rootOf(sessionId), { event: 'assignment.resumed', assignmentId: sessionId, agent: session.mapping.agent.name });
      if (assignment) emit(session.parent!, { type: 'assignment', assignment: assignmentSnapshot(assignment, 'running') });
      try {
        await startPrompt(sessionId, {
          clientMessageId: `alp-resume-${randomUUID()}`,
          delivery: 'auto',
          content: [{ type: 'text', text: prompt ?? (session.parent
            ? `ALP resumed this assignment; it had stopped because ${reason}. Continue where you left off: your earlier work in this session and its files are intact. Finish with alp_handoff as before.`
            : `ALP resumed this session; it had stopped because ${reason}. Continue the user's request where you left off: your earlier work in this thread and its files are intact.`) }],
        }, session.parent ? 'assignment' : 'wake');
        session.resumedTurn = session.active;
        emit(sessionId, { type: 'session.updated', session: snapshot(sessionId, session) });
      } catch (error) {
        if (!session.closed && !session.active) {
          session.parked = parked;
          emit(sessionId, { type: 'session.updated', session: snapshot(sessionId, session) });
          if (assignment) emit(session.parent!, { type: 'assignment', assignment: assignmentSnapshot(assignment, 'parked') });
        }
        notice('warning', `Could not resume ${session.mapping.agent.name}: ${errorData(error).message}`);
      }
    });
  }

  /** When a limit resets, from what the runtime last reported: the latest reset of a window that is used up. */
  async function limitReset(session: Session, error: any): Promise<string | undefined> {
    const at = (seconds: unknown) => typeof seconds === 'number' && seconds > 0 ? new Date(seconds * 1000).toISOString() : undefined;
    if (error?.resetsAt) return at(error.resetsAt);
    const report = usage.get(session.runtimeKind);
    if (session.runtimeKind === 'claude') return at(report?.claude?.resetsAt);
    let windows = [report?.rateLimits?.primary, report?.rateLimits?.secondary].filter(Boolean);
    if (!windows.some(window => window.usedPercent >= 100)) {
      const context: any = await session.runtime.orchestrationContext?.().catch(() => undefined);
      windows = (context?.usage?.limits ?? []).flatMap((limit: any) => limit.windows ?? []);
    }
    const resets = windows.filter(window => window.usedPercent >= 100 && window.resetsAt).map(window => window.resetsAt as number);
    return resets.length ? at(Math.max(...resets)) : undefined;
  }

  /** A turn failed on a usage limit: pause that runtime for delegation and wakes, and tell the user. */
  async function limitReached(session: Session, error: any) {
    const kind = session.runtimeKind;
    if (pauseOf(kind)) return;
    const resetsAt = await limitReset(session, error);
    // A user's pause made while the provider lookup awaited remains theirs to lift.
    if (closed || session.closed || pauseOf(kind)) return;
    const pause: Pause = { since: new Date().toISOString(), by: 'alpd', reason: `${label(kind)} usage limit reached`, ...(resetsAt ? { resetsAt } : {}) };
    pauseRuntime(kind, pause);
    const other = RUNTIMES.find(candidate => candidate !== kind && !pauseOf(candidate));
    notice('error', say => say.limitReached(label(kind), resetsAt, other && label(other), options.autoResume !== false, kind));
  }

  /**
   * Tells a session once that its context nears compaction (ALPD §57), measured against
   * the fill at which its runtime compacts: Claude says where; otherwise COMPACT_SHARE of
   * the window, or of the context setting. Nothing earlier, and no push to hand off: the
   * runtime compacts and keeps going, and ALP gives the session its state again after.
   */
  function contextReport(sessionId: string, session: Session, usage: any) {
    const used = usage?.last?.totalTokens;
    const window = usage?.modelContextWindow;
    if (session.role === 'supervisor' || typeof used !== 'number' || typeof window !== 'number' || window <= 0) return;
    session.contextFill = contextFill(usage);
    const compactAt = typeof usage.autoCompactTokens === 'number' && usage.autoCompactTokens > 0
      ? usage.autoCompactTokens
      : session.runtimeKind === 'codex' && session.mapping.autocompact
        ? Math.min(session.mapping.autocompact, Math.round(window * COMPACT_SHARE))
        : Math.round(Math.min(session.mapping.autocompact ?? session.mapping.context ?? window, window) * COMPACT_SHARE);
    const fill = used / compactAt;
    if (fill < CONTEXT_RESET) { session.contextLevel = 0; return; }
    if (fill < CONTEXT_SOON || session.contextLevel) return;
    session.contextLevel = 1;
    runLog(rootOf(sessionId), { event: 'context', sessionId, agent: session.mapping.agent.name, tokens: used, compactAt, level: 'soon' });
    const size = `Your context holds about ${thousands(used)} tokens; the runtime compacts it at about ${thousands(compactAt)} and keeps going.`;
    const body = session.parent
      ? `${size} No handoff is needed for that: keep working. After the compaction ALP gives you your brief again; write anything you will need later where it lasts, such as your task's notes.`
      : `${size} Make sure decisions and findings are pinned with alp_pin and task notes are current; after the compaction ALP gives you your assignments, open questions and tasks again.`;
    // During a turn it steers in; otherwise it waits for the next turn without starting one.
    post(sessionId, { kind: 'note', from: 'alp', assignment: sessionId, body, ...(session.active ? {} : { passive: true }) });
  }

  /**
   * An agent starting to use one of its skills (ALPD §59): Claude's Skill tool naming it,
   * or a command or tool reading its SKILL.md. Logged once per session and skill, and
   * told to the supervisor, so how often skills are used can be read off the run log.
   */
  function skillUse(sessionId: string, session: Session, item: any) {
    const skills = session.mapping.agent.skills;
    if (!skills.length || item.type === 'agentMessage' || item.type === 'reasoning') return;
    const text = typeof item.command === 'string' ? item.command : JSON.stringify(item).slice(0, 20_000);
    if (!text.includes('SKILL.md') && !text.includes('Skill')) return;
    for (const skill of skills) {
      if (session.skillsUsed?.has(skill.name)) continue;
      const called = new RegExp(`^Skill \\{"skill":"(?:${SKILL_PLUGIN}:)?${skill.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).test(text);
      const read = text.includes(skill.path) || text.includes(`/skills/${skill.name}/SKILL.md`);
      if (!called && !read) continue;
      (session.skillsUsed ??= new Set()).add(skill.name);
      runLog(rootOf(sessionId), { event: 'skill', sessionId, agent: session.mapping.agent.name, skill: skill.name, via: called ? 'skill' : 'read' });
      if (session.supervisor) session.journal.push(stamp(`${session.mapping.agent.name} used skill ${skill.name}`));
    }
  }

  /**
   * A compaction of the session's context, from its start to its end (ALPD §57): shown in
   * its timeline and the run log; once done, ALP tells the session what it holds of its
   * work, which the runtime's summary may have lost.
   */
  function compaction(sessionId: string, session: Session, item: any, done: boolean) {
    const failed = done && item.status === 'failed';
    const tokens = { ...(typeof item.preTokens === 'number' ? { preTokens: item.preTokens } : {}), ...(typeof item.postTokens === 'number' ? { postTokens: item.postTokens } : {}) };
    const trigger = item.trigger === 'manual' || item.trigger === 'auto' ? { trigger: item.trigger as 'manual' | 'auto' } : {};
    emit(sessionId, { type: 'item', item: { kind: 'compaction', id: String(item.id), status: !done ? 'running' : failed ? 'failed' : 'completed', ...trigger, ...tokens } });
    if (!done) return;
    const agent = session.mapping.agent.name;
    runLog(rootOf(sessionId), { event: 'compacted', sessionId, agent, ...trigger, ...tokens, ...(failed ? { failed: true, ...(item.error ? { error: String(item.error) } : {}) } : {}) });
    if (failed) { if (session.compacting?.phase === 'native') compactFailed(sessionId, session, item.error ? String(item.error) : 'the runtime could not compact'); return; }
    session.contextLevel = 0;
    if (session.supervisor) session.journal.push(stamp(`${agent}'s context was compacted`));
    const checkpoint = session.compacting?.phase === 'native' ? session.compacting.checkpoint : undefined;
    if (session.role !== 'supervisor') void restoreAfterCompaction(sessionId, session, checkpoint).catch(() => {});
    if (checkpoint !== undefined) compactFinished(sessionId, session, 'native');
  }

  /**
   * Whether a root holds anything a compaction must not cut into (t-0e56): a turn, a restart,
   * a question to the user, mail that wakes it, a park or the supervisor's review.
   */
  function compactHeld(sessionId: string, session: Session) {
    return session.closed || !!session.active || !!session.pending || session.waiters.length > 0 || hasActiveMail(session) || !!session.wakeHeld
      || !!session.parked || !!session.parkReason || reviewing(session)
      || [...userQuestions.values()].some(pending => pending.question.rootId === sessionId && !pending.gate);
  }

  /**
   * Main's compaction at a turn boundary (t-0e56). Once its context fills to the threshold,
   * or the user asked, main writes a checkpoint by skill compact in a turn of its own; at that
   * turn's end the runtime compacts natively, or ALP starts a fresh conversation seeded with it.
   * Anything that holds the session defers it to a later boundary.
   */
  function compactAtBoundary(sessionId: string, session: Session, state: 'completed' | 'failed' | 'canceled') {
    if (session.closed || sessions.get(sessionId) !== session) return;
    const current = session.compacting;
    if (current?.phase === 'checkpoint' && current.checkpoint === undefined) {
      // The checkpoint turn just ended: its last words are the checkpoint.
      const written = [...session.text.values()].at(-1)?.trim();
      if (state !== 'completed' || !written) { compactFailed(sessionId, session, state !== 'completed' ? `the checkpoint turn ${state}` : 'main wrote no checkpoint'); return; }
      current.checkpoint = written;
    }
    // The compaction turn ended without the runtime reporting a compaction.
    if (current?.phase === 'native') { compactFailed(sessionId, session, 'the runtime reported no compaction'); return; }
    if (compactHeld(sessionId, session)) return;
    if (current?.checkpoint !== undefined) { void compactNow(sessionId, session); return; }
    if (current) return;
    if (session.compactBuffer?.length) { flushCompactBuffer(sessionId, session); return; }
    const trigger = compactDue(session.mapping.compact ?? { auto: false, threshold: 1 }, session.contextFill, !!session.compactRequested);
    if (!trigger) return;
    if (trigger === 'auto' && session.compactFailedAt && Date.now() - session.compactFailedAt < COMPACT_RETRY_MS) return;
    session.compactRequested = false;
    session.compacting = { phase: 'checkpoint', trigger, startedAt: Date.now() };
    runLog(rootOf(sessionId), { event: 'compact.started', sessionId, agent: session.mapping.agent.name, trigger, ...(session.contextFill !== undefined ? { fill: Math.round(session.contextFill * 100) / 100 } : {}) });
    const work = queue.then(async () => {
      if (session.closed || compactHeld(sessionId, session)) { session.compacting = undefined; if (trigger === 'manual') session.compactRequested = true; return; }
      await startPrompt(sessionId, { clientMessageId: `alp-wake-compact-${randomUUID()}`, delivery: 'auto', content: [{ type: 'text', text: checkpointPrompt(trigger, session.contextFill) }] }, 'wake');
    }).catch(error => compactFailed(sessionId, session, errorData(error).message));
    queue = work.catch(() => {});
  }

  /** Compacts with the runtime's own mechanism, else a fresh conversation seeded with the checkpoint. */
  async function compactNow(sessionId: string, session: Session) {
    const current = session.compacting!;
    const checkpoint = current.checkpoint!;
    if (NATIVE_COMPACT.includes(session.runtimeKind) && current.phase === 'checkpoint') {
      current.phase = 'native';
      try {
        // Codex takes the thread alone; its summary gets the checkpoint back from the note ALP sends after.
        await session.runtime.request('thread/compact/start', { threadId: session.threadId, ...(session.runtimeKind === 'codex' ? {} : { instructions: compactInstructions(checkpoint) }) });
        return;
      } catch (error) {
        runLog(rootOf(sessionId), { event: 'compact.native_failed', sessionId, agent: session.mapping.agent.name, error: errorData(error).message });
        current.phase = 'fresh';
      }
    }
    current.phase = 'fresh';
    // A fresh conversation drops the old one: only when nothing runs that it would lose.
    if (restartRefusal(sessionId, session)) return;
    const work = queue.then(async () => {
      if (session.closed || restartRefusal(sessionId, session)) return;
      await restartNative(sessionId, session, undefined);
      emit(sessionId, { type: 'session.updated', session: snapshot(sessionId, session) });
      await startPrompt(sessionId, { clientMessageId: `alp-wake-compact-${randomUUID()}`, delivery: 'auto', content: [{ type: 'text', text: seedPrompt(checkpoint, session.lastUserText) }] }, 'wake');
      compactFinished(sessionId, session, 'fresh');
    }).catch(error => compactFailed(sessionId, session, errorData(error).message));
    queue = work.catch(() => {});
  }

  function compactFinished(sessionId: string, session: Session, via: 'native' | 'fresh') {
    const current = session.compacting;
    if (!current) return;
    session.compacting = undefined;
    session.compactFailedAt = undefined;
    session.contextFill = undefined;
    runLog(rootOf(sessionId), { event: 'compact', sessionId, agent: session.mapping.agent.name, trigger: current.trigger, via, checkpointChars: current.checkpoint?.length ?? 0, ms: Date.now() - current.startedAt });
    const text = wordsFor(session).compacted(via === 'native');
    emit(sessionId, { type: 'item', item: { kind: 'notice', id: `notice-${randomUUID().slice(0, 8)}`, level: 'info', text } });
    queueMicrotask(() => flushCompactBuffer(sessionId, session));
  }

  function compactFailed(sessionId: string, session: Session, reason: string) {
    const current = session.compacting;
    session.compacting = undefined;
    session.compactFailedAt = Date.now();
    runLog(rootOf(sessionId), { event: 'compact.failed', sessionId, agent: session.mapping.agent.name, ...(current ? { trigger: current.trigger } : {}), error: reason });
    if (!session.closed) emit(sessionId, { type: 'item', item: { kind: 'notice', id: `notice-${randomUUID().slice(0, 8)}`, level: 'warning', text: wordsFor(session).compactFailed(reason) } });
    queueMicrotask(() => flushCompactBuffer(sessionId, session));
  }

  /** Sends the user's words held during a compaction, in order, once no turn runs (t-0e56). */
  function flushCompactBuffer(sessionId: string, session: Session) {
    if (session.compacting || session.active || !session.compactBuffer?.length) return;
    const held = session.compactBuffer.splice(0);
    session.compactBuffer = undefined;
    const work = queue.then(async () => {
      for (const [index, input] of held.entries()) {
        await promptSession(sessionId, { ...input, delivery: index === 0 && !session.active ? 'auto' : 'steer' }, true);
      }
    });
    queue = work.catch(() => {});
  }

  /** The user's request to compact a root (t-0e56): now if it is idle, else at its next turn boundary. */
  function requestCompact(sessionId: string) {
    const session = sessions.get(sessionId);
    if (!session || session.closed) throw new ConversationError('session_busy', 'The session is not open');
    if (session.parent || session.role === 'supervisor') throw new ConversationError('runtime_unsupported', 'Only a root session is compacted');
    if (session.compacting) return { status: 'running' as const };
    session.compactRequested = true;
    if (compactHeld(sessionId, session)) return { status: 'deferred' as const };
    compactAtBoundary(sessionId, session, 'completed');
    return { status: 'started' as const };
  }

  /** What ALP holds of a session's work, told to it after a compaction (ALPD §57). */
  async function restoreAfterCompaction(sessionId: string, session: Session, checkpoint?: string) {
    const parts = ['Your context was just compacted. In case the summary lost any of it, this is what ALP holds of your work now.'];
    if (session.parent && session.brief) parts.push(`Your assignment from ${session.parentAgent ?? 'your requester'}, as it was given:\n${cut(session.brief, BRIEF_CHARS)}`);
    const running = [...session.assignments.values()].filter(assignment => !assignment.finished);
    if (running.length) {
      parts.push('Your assignments still open:\n' + running.map(assignment =>
        `- ${assignment.id}: ${assignment.agent}${assignment.taskId ? ` on ${assignment.taskId}` : ''}, ${sessions.get(assignment.id)?.parked ? 'parked' : 'running'} for ${span(Date.now() - assignment.startedAt)}`).join('\n'));
    }
    if (session.worktrees.size) {
      parts.push('Finished worktree changes waiting for alp_merge or alp_discard:\n' + [...session.worktrees].map(([id, change]) => `- ${id}: ${change.agent}${change.taskId ? ` on ${change.taskId}` : ''}`).join('\n'));
    }
    const asked = [...userQuestions.values()].filter(pending => pending.question.sessionId === sessionId && !pending.gate);
    if (asked.length) parts.push('Waiting for the user to answer:\n' + asked.map(pending => `- ${clip(pending.question.body, 300)}`).join('\n'));
    if (!session.parent) {
      const project = session.mapping.agent.projectRoot;
      const tasks = await loadTasks(project).then(({ tasks, errors }) => taskDigest(tasks, errors), () => '');
      if (tasks) parts.push(tasks);
      const board = renderBoard(await boardOf(project));
      if (board) parts.push(board);
    }
    if (checkpoint) parts.push(`The checkpoint you wrote before the compaction, by skill compact:\n${cut(checkpoint, BRIEF_CHARS)}`);
    parts.push('Carry on where you were; alp_board and alp_task tell you more.');
    if (session.closed) return;
    post(sessionId, { kind: 'note', from: 'alp', assignment: sessionId, body: parts.join('\n\n'), ...(session.active ? {} : { passive: true }) });
  }

  /** Remembers a runtime's usage report and warns once per window when it nears its limit. */
  function usageReport(session: Session, params: any) {
    const kind = session.runtimeKind;
    usage.set(kind, params);
    const claude = params?.claude;
    const windows = [params?.rateLimits?.primary, params?.rateLimits?.secondary].filter(Boolean);
    const high = claude ? (claude.status === 'allowed_warning' ? { used: claude.utilization, resetsAt: claude.resetsAt } : undefined)
      : windows.filter(window => window.usedPercent >= 90 && window.usedPercent < 100).map(window => ({ used: window.usedPercent, resetsAt: window.resetsAt }))[0];
    if (!high) return;
    const key = `${kind}:${high.resetsAt ?? ''}`;
    if (warned.has(key)) return;
    warned.add(key);
    const used = typeof high.used === 'number' ? `${Math.round(high.used <= 1 ? high.used * 100 : high.used)}%` : 'nearly all';
    notice('warning', say => say.usageWarning(label(kind), used, high.resetsAt ? new Date(high.resetsAt * 1000).toISOString() : undefined));
  }

  // A limit pause an earlier alpd left is checked at once: the limit may have lifted meanwhile.
  watchLimits();
  for (const kind of RUNTIMES) void checkLimit(kind);

  /** Projects whose tasks this runtime checked for assignments an earlier alpd left behind. */
  const orphanChecks = new Map<string, Promise<void>>();

  /**
   * Once per project: tasks an assignment of an earlier alpd held go back to open,
   * since that assignment ended with it. Another live alpd's assignments are left alone.
   */
  function releaseOrphansOnce(project: string, rootId: string) {
    // Another alpd that is still running keeps its tasks; a pid reused by another process does not.
    const check = orphanChecks.get(project) ?? releaseOrphans(project,
      assignee => assignee.epoch !== epoch && !(assignee.pid && assignee.pid !== process.pid && sameProcessAlive(assignee.pid, assignee.pidStartedAt)),
      async assignee => await branchExists(project, `alp/${assignee.assignment}`) ? `work kept on branch alp/${assignee.assignment}` : undefined,
      'alpd',
    ).then(released => {
      for (const task of released) {
        touchTask(rootId, task.id);
        runLog(rootId, { event: 'task', action: 'orphaned', agent: 'alpd', id: task.id, title: task.title, status: task.status, detail: task.log.at(-1)?.note ?? 'its assignment ended with an earlier alpd' });
      }
    }, () => {});
    orphanChecks.set(project, check);
    return check;
  }

  const gateChecks = new Map<string, number>();

  /** Clears GitHub gates whose pull request merged or run succeeded, at most once a minute per project. */
  async function checkGatesOften(project: string) {
    if (Date.now() - (gateChecks.get(project) ?? 0) < 60_000) return;
    const { tasks } = await loadTasks(project);
    if (!tasks.some(task => task.status !== 'closed' && task.gates.some(gate => (gate.kind === 'gh:pr' || gate.kind === 'gh:run') && !gate.resolved))) return;
    gateChecks.set(project, Date.now());
    const { cleared } = await checkGates(project, options.github ?? gh);
    for (const { task } of cleared) for (const [id, session] of sessions) if (!session.parent && session.mapping.agent.projectRoot === project && session.tasks.includes(task)) runLog(id, { event: 'task', action: 'clear', agent: 'github', id: task, title: tasks.find(entry => entry.id === task)?.title ?? '', status: 'open' });
  }

  /** Records that a root's tree created or worked on a task, for the root's todo list. */
  function touchTask(rootId: string, id: string) {
    const root = sessions.get(rootId);
    if (root && !root.tasks.includes(id)) root.tasks.push(id);
  }

  /** Shows the tasks a root's tree worked on as a todo list in its timeline, when the list changed. */
  async function showTasks(sessionId: string, session: Session) {
    if (!session.tasks.length) return;
    const { tasks } = await loadTasks(session.mapping.agent.projectRoot).catch(() => ({ tasks: [] as Task[] }));
    const index = new Map(tasks.map(task => [task.id, task]));
    const items = session.tasks.flatMap(id => {
      const task = index.get(id);
      return task ? [{
        id: task.id,
        text: `${task.id} · ${task.title}${task.status === 'review' ? ' (awaiting acceptance)' : ''}`,
        status: task.status === 'open' ? 'pending' as const : task.status === 'closed' ? 'completed' as const : 'in_progress' as const,
      }] : [];
    });
    const shown = JSON.stringify(items);
    if (!items.length || shown === session.tasksShown || session.closed) return;
    session.tasksShown = shown;
    emit(sessionId, { type: 'item', item: { kind: 'todo', id: `tasks-${randomUUID().slice(0, 8)}`, items } });
  }

  /** The project's lessons file, then the user's when this host keeps a library. */
  function lessonFiles(mapping: ResolvedSession) {
    return [path.join(mapping.agent.projectRoot, '.alp', LESSONS_FILE), ...(options.libraryDir ? [path.join(options.libraryDir, LESSONS_FILE)] : [])];
  }

  /**
   * Asks the user to approve a proposal and waits for the answer. Only an approving
   * answer approves; a dismissal, a timeout or another answer does not.
   */
  async function confirm(sessionId: string, session: Session, body: string, approval?: { id: string }): Promise<{ approved: boolean; feedback?: string; outcome?: string }> {
    if ([...userQuestions.values()].some(pending => pending.question.sessionId === sessionId && !pending.gate)) return { approved: false, outcome: 'busy', feedback: 'A question is already waiting for the user' };
    const say = wordsFor(session);
    const result = await askUser(sessionId, session, undefined, body, [say.approve, say.reject], approval) as { contentItems: Array<{ text: string }> };
    let value: any;
    try { value = JSON.parse(result.contentItems[0].text); } catch { value = {}; }
    if (value.status !== 'answered') return { approved: false, outcome: value.status ?? 'canceled', ...(value.reason ? { feedback: value.reason } : {}) };
    const answer = String(value.answer).trim();
    return APPROVALS.includes(answer.toLowerCase()) ? { approved: true } : { approved: false, outcome: 'answered', feedback: answer };
  }

  const text = (value: unknown, limit: number) => typeof value === 'string' && !!value.trim() && value.length <= limit;

  // Approvals of alp_issue and alp_skill (#114, #116): the tool returns a pending id at once and the
  // decision comes as result mail. Draft identities stay until session close, so a replayed tool
  // call or turn never applies an approved draft twice. Interrupting a session cancels its approvals.
  const approvalCancellation = new WeakMap<Session, number>();
  const approvalLedger = new Map<string, Map<string, { approvalId: string; draftKey: string; result?: Record<string, unknown> }>>();
  const approvalsOf = (sessionId: string) => {
    let approvals = approvalLedger.get(sessionId);
    if (!approvals) approvalLedger.set(sessionId, approvals = new Map());
    return approvals;
  };
  const approvalCanceled = (session: Session, cancellation: number) => closed || session.closed || cancellation !== (approvalCancellation.get(session) ?? 0);

  async function skillTool(sessionId: string, session: Session, args: unknown) {
    const cancellation = approvalCancellation.get(session) ?? 0;
    args = structuredClone(args);
    if (
      !plainObject(args, ['name', 'description', 'body', 'roles', 'lessons', 'replace', 'requestId']) ||
      typeof args.name !== 'string' || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(args.name) ||
      !text(args.description, 300) || !text(args.body, SKILL_BODY_CHARS) ||
      !Array.isArray(args.roles) || !args.roles.length || args.roles.length > 10 || !args.roles.every((role: unknown) => typeof role === 'string' && /^[\w.-]+$/.test(role) && role !== '.' && role !== '..') ||
      (args.lessons !== undefined && (!Array.isArray(args.lessons) || args.lessons.length > 50 || !args.lessons.every((lesson: unknown) => text(lesson, LESSON_CHARS)))) ||
      (args.replace !== undefined && typeof args.replace !== 'boolean')
    ) {
      return toolResult(false, { error: `A skill needs a name (lowercase letters, digits, hyphens), a one-line description, a body of at most ${SKILL_BODY_CHARS} characters, and the roles that get it` });
    }
    if (args.requestId !== undefined && !text(args.requestId, 100)) return toolResult(false, { error: 'requestId must be a nonempty string of at most 100 characters' });
    const library = options.libraryDir;
    if (!library) return toolResult(false, { error: 'This host keeps no user skill library' });
    const known = new Set([...STARTER_ROLES, ...await discoverAgents(session.mapping.agent.projectRoot, { library, templates: options.templates })]);
    const unknown = args.roles.filter((role: string) => !known.has(role));
    if (unknown.length) return toolResult(false, { error: `Unknown roles: ${unknown.join(', ')}. Roles are ${[...known].join(', ')}` });
    const file = path.join(library, 'skills', args.name, 'SKILL.md');
    const content = `---\nname: ${args.name}\ndescription: ${JSON.stringify(args.description.replace(/\s+/g, ' ').trim())}\n---\n\n${args.body.trim()}\n`;
    const normalizeLesson = (lesson: string) => lesson.replace(/\s+/g, ' ').trim().replace(/^(?:- )?\d{4}-\d\d-\d\d: /, '').trim();
    const lessons: string[] = [...new Set<string>((args.lessons ?? []).map(normalizeLesson))];
    // A replay of a proposed draft returns its approval, before anything it changed is checked again.
    const draftKey = JSON.stringify(['skill', content, args.roles, lessons, !!args.replace]);
    const key = `skill:${args.requestId ?? draftKey}`;
    const approvals = approvalsOf(sessionId);
    const previous = approvals.get(key);
    if (previous && previous.draftKey !== draftKey) return toolResult(false, { error: 'requestId was already used for a different draft' });
    if (previous) return toolResult(true, previous.result ?? { status: 'pending_approval', approvalId: previous.approvalId, file });
    const existing = await readFile(file, 'utf8').catch(() => undefined);
    if (existing !== undefined && !args.replace) return toolResult(false, { error: `The library already has a skill named ${args.name} (${file}); read it, then pass replace: true to propose a new version, or choose another name` });
    const rolesFile = path.join(library, 'role-skills.json');
    const readRoles = async () => {
      const raw = await readFile(rolesFile, 'utf8').catch(() => '{}');
      const roles = JSON.parse(raw);
      if (!roles || typeof roles !== 'object' || Array.isArray(roles)) throw new Error(`${rolesFile} must be an object of role names to skill lists`);
      return roles as Record<string, unknown>;
    };
    try { await readRoles(); } catch (error) { return toolResult(false, { error: errorData(error).message }); }
    if (approvalCanceled(session, cancellation)) return toolResult(false, { error: 'Skill proposal canceled or session closed; no approval was created' });
    if ([...userQuestions.values()].some(pending => pending.question.sessionId === sessionId && !pending.gate)) return toolResult(false, { error: 'A question is already waiting for the user; finish it before proposing a skill' });
    const approvalId = `q-${randomUUID()}`;
    const record: { approvalId: string; draftKey: string; result?: Record<string, unknown> } = { approvalId, draftKey };
    approvals.set(key, record);
    const say = wordsFor(session);
    // The user sees the whole skill, as it will be saved.
    const decision = confirm(sessionId, session,
      say.skill(session.mapping.agent.name, existing !== undefined, file, args.roles.join(', '), lessons) +
      `\n${say.answerLine(session.mapping.agent.name)}\n\n${content}`, { id: approvalId });
    const save = async (): Promise<Record<string, unknown>> => {
      // A skill of this name saved meanwhile is not overwritten by a proposal that was not a replacement.
      if (existing === undefined && !args.replace && await readFile(file, 'utf8').then(() => true, () => false)) {
        return { approved: true, saved: false, error: `A skill named ${args.name} was saved meanwhile (${file}); nothing was overwritten`, next: 'Read it, then propose again with replace: true if yours should replace it.' };
      }
      try {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, content);
        const roles = await readRoles();
        for (const role of args.roles) {
          const list = Array.isArray(roles[role]) ? roles[role] as string[] : [];
          if (!list.includes(args.name)) list.push(args.name);
          roles[role] = list;
        }
        await writeFile(rolesFile, JSON.stringify(roles, null, 2) + '\n');
      } catch (error) {
        return { approved: true, saved: false, error: errorData(error).message, next: 'Tell the user; nothing is retried automatically.' };
      }
      // Compare exact rule text after normalizing whitespace and the optional recorded date.
      const removed = new Set<string>();
      for (const lessonFile of lessonFiles(session.mapping)) {
        const current = await readFile(lessonFile, 'utf8').catch(() => undefined);
        if (current === undefined) continue;
        const kept = current.split('\n').filter(line => {
          const match = /^- \d{4}-\d\d-\d\d: (.*)$/.exec(line);
          if (!match) return true;
          const lesson = normalizeLesson(line);
          if (!lessons.includes(lesson)) return true;
          removed.add(lesson);
          return false;
        });
        if (kept.length !== current.split('\n').length) await writeFile(lessonFile, kept.join('\n')).catch(() => {});
      }
      runLog(rootOf(sessionId), { event: 'skill', agent: session.mapping.agent.name, name: args.name, roles: args.roles, replaced: existing !== undefined, lessons: [...removed] });
      return {
        approved: true, saved: file, roles: args.roles, lessonsRemoved: [...removed],
        ...(lessons.length > removed.size ? { lessonsNotFound: lessons.filter(lesson => !removed.has(lesson)) } : {}),
        next: 'New sessions of those roles list the skill; read the file now if you need it in this one.',
      };
    };
    void (async () => {
      const answer = await decision;
      const canceled = approvalCanceled(session, cancellation);
      const result = !answer.approved || canceled
        ? { approved: false, saved: false, outcome: canceled ? 'canceled' : answer.outcome, ...(answer.feedback ? { feedback: answer.feedback } : {}), next: 'Nothing was saved. Revise from the feedback and propose again with a fresh requestId, or drop it.' }
        : await save();
      record.result = { status: 'resolved', approvalId, name: args.name, ...result };
      runLog(rootOf(sessionId), { event: 'skill.approval', agent: session.mapping.agent.name, ...record.result });
      if (!closed && !session.closed && sessions.get(sessionId) === session) {
        // Result mail renews the bounded wake allowance and reaches this main only.
        post(sessionId, { kind: 'result', from: 'ALP', assignment: approvalId, body: `Skill approval result: ${JSON.stringify(record.result)}` });
      }
    })();
    return toolResult(true, { status: 'pending_approval', approvalId, file, next: 'Continue other work or end your turn. ALP sends the user\'s decision, and whether the skill was saved, by mail; do not resubmit this draft.' });
  }

  let scheduleHandler: ScheduleHandler | undefined;

  async function scheduleTool(sessionId: string, session: Session, args: unknown) {
    if (session.parent || session.role === 'supervisor' || session.mapping.agent.name !== mainOf(session.mapping)) return toolResult(false, { error: 'Only the main root session schedules continuations' });
    if (!scheduleHandler) return toolResult(false, { error: 'This host does not support scheduled continuations' });
    if (!plainObject(args, ['action', 'dueAt', 'prompt', 'requestId', 'id', 'status']) || !['create', 'list', 'get', 'cancel'].includes(args.action)) return toolResult(false, { error: 'Unknown schedule action' });
    const action = args.action as 'create' | 'list' | 'get' | 'cancel';
    const fields = action === 'create' ? ['action', 'dueAt', 'prompt', 'requestId'] : action === 'list' ? ['action', 'status'] : ['action', 'id'];
    if (Object.keys(args).some(key => !fields.includes(key))) return toolResult(false, { error: 'Unexpected schedule argument' });
    const handler = scheduleHandler;
    const projectRoot = session.mapping.agent.projectRoot;
    const invoke = async (params: Record<string, unknown>) => {
      try { return toolResult(true, await handler(action, { ...params, projectRoot })); }
      catch (error) { return toolResult(false, { error: errorData(error).message }); }
    };
    if (action !== 'create') return invoke(action === 'list' ? { ...(args.status ? { status: args.status } : {}) } : { id: args.id });
    if (!text(args.requestId, 200) || !text(args.prompt, 8000) || !text(args.dueAt, 80) ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(args.dueAt) || !Number.isFinite(Date.parse(args.dueAt))) return toolResult(false, { error: 'create needs requestId, prompt (1–8000 characters) and dueAt with an explicit UTC offset' });
    const draftKey = JSON.stringify([args.dueAt, args.prompt]);
    const key = `schedule:${args.requestId}`;
    const approvals = approvalsOf(sessionId);
    const previous = approvals.get(key);
    if (previous) return previous.draftKey !== draftKey
      ? toolResult(false, { error: 'requestId already names another schedule draft' })
      : toolResult(true, previous.result ?? { status: 'pending_approval', approvalId: previous.approvalId });
    const cancellation = approvalCancellation.get(session) ?? 0;
    const approvalId = `q-${randomUUID()}`;
    const record: { approvalId: string; draftKey: string; result?: Record<string, unknown> } = { approvalId, draftKey };
    approvals.set(key, record);
    const decision = confirm(sessionId, session,
      `Tạo lịch tiếp tục một lần?\nProject: ${projectRoot}\nSession: ${sessionId}\nThời gian: ${args.dueAt} (${new Date(args.dueAt).toISOString()})\n\n${args.prompt}`, { id: approvalId });
    void decision.then(async answer => {
      const canceled = approvalCanceled(session, cancellation);
      let result: Record<string, unknown>;
      if (!answer.approved || canceled) result = { approved: false, created: false, outcome: canceled ? 'canceled' : answer.outcome, feedback: answer.feedback };
      else {
        try { result = { approved: true, created: true, ...await handler('create', { projectRoot, sessionId, dueAt: args.dueAt, prompt: args.prompt }) as object }; }
        catch (error) { result = { approved: true, created: false, error: errorData(error).message }; }
      }
      record.result = { status: 'resolved', approvalId, ...result };
      runLog(rootOf(sessionId), { event: 'schedule.approval', ...record.result });
      if (!session.closed) post(sessionId, { kind: 'result', from: 'ALP', assignment: approvalId, body: `Schedule approval result: ${JSON.stringify(record.result)}` });
    }).catch(error => { record.result = { status: 'resolved', approvalId, created: false, error: errorData(error).message }; });
    return toolResult(true, { status: 'pending_approval', approvalId, next: 'Continue other work or end your turn. ALP sends the decision and creation result by mail; do not resubmit this draft.' });
  }

  async function issueTool(sessionId: string, session: Session, args: unknown) {
    const cancellation = approvalCancellation.get(session) ?? 0;
    args = structuredClone(args);
    if (!plainObject(args, ['action', 'target', 'query', 'title', 'body', 'issue', 'labels', 'requestId']) || !['search', 'create', 'comment'].includes(args.action) || !['project', 'alp'].includes(args.target)) {
      return toolResult(false, { error: 'An issue call needs action (search, create or comment) and target (project or alp)' });
    }
    const project = session.mapping.agent.projectRoot;
    let repo: string;
    try { repo = args.target === 'alp' ? ALP_REPO : await projectRepo(project); }
    catch (error) { return toolResult(false, { error: errorData(error).message }); }
    const github = options.github ?? gh;
    if (args.action === 'search') {
      if (!text(args.query, 200)) return toolResult(false, { error: 'search needs a query of at most 200 characters' });
      try {
        const output = await github(['issue', 'list', '-R', repo, '--state', 'all', '--limit', '10', '--search', args.query, '--json', 'number,title,state,url'], { cwd: project });
        return toolResult(true, { repo, issues: JSON.parse(output || '[]') });
      } catch (error) {
        return toolResult(false, { repo, error: errorData(error).message });
      }
    }
    if (!text(args.body, ISSUE_BODY_CHARS)) return toolResult(false, { error: `${args.action} needs a body of at most ${ISSUE_BODY_CHARS} characters` });
    if (args.action === 'create' && !text(args.title, 200)) return toolResult(false, { error: 'create needs a title of at most 200 characters' });
    if (args.action === 'comment' && (!Number.isSafeInteger(args.issue) || args.issue < 1)) return toolResult(false, { error: 'comment needs the issue number' });
    if (args.labels !== undefined && (args.action !== 'create' || !Array.isArray(args.labels) || args.labels.length > 10 || !args.labels.every((label: unknown) => text(label, 50)))) {
      return toolResult(false, { error: 'labels are up to 10 existing label names, for create' });
    }
    if (args.requestId !== undefined && !text(args.requestId, 100)) return toolResult(false, { error: 'requestId must be a nonempty string of at most 100 characters' });
    // Resolve labels before approval, so a draft with an unknown label never
    // consumes the user's approval and then fails during issue creation.
    if (args.action === 'create' && args.labels?.length) {
      try {
        const labels = JSON.parse(await github(['label', 'list', '-R', repo, '--limit', '1000', '--json', 'name'], { cwd: project }));
        const names = new Set(labels.map((label: { name: string }) => label.name.toLowerCase()));
        const missingLabels = args.labels.filter((label: string) => !names.has(label.toLowerCase()));
        if (missingLabels.length) return toolResult(false, { repo, error: `Unknown repository labels: ${missingLabels.join(', ')}`, missingLabels, next: 'Remove these labels or use existing labels, then submit the draft for approval.' });
      } catch (error) {
        return toolResult(false, { repo, error: `Could not validate issue labels: ${errorData(error).message}` });
      }
    }
    if (approvalCanceled(session, cancellation)) return toolResult(false, { error: 'Issue proposal canceled or session closed; no approval was created' });
    const draftKey = JSON.stringify([repo, args.action, args.title ?? null, args.issue ?? null, args.body, [...(args.labels ?? [])].sort()]);
    const key = `issue:${args.requestId ?? draftKey}`;
    const approvals = approvalsOf(sessionId);
    const previous = approvals.get(key);
    if (previous && previous.draftKey !== draftKey) return toolResult(false, { error: 'requestId was already used for a different draft' });
    if (previous) return toolResult(true, previous.result ?? { status: 'pending_approval', approvalId: previous.approvalId, repo });
    if ([...userQuestions.values()].some(pending => pending.question.sessionId === sessionId && !pending.gate)) return toolResult(false, { error: 'A question is already waiting for the user; finish it before proposing another issue draft' });
    const approvalId = `q-${randomUUID()}`;
    const record: { approvalId: string; draftKey: string; result?: Record<string, unknown> } = { approvalId, draftKey };
    approvals.set(key, record);
    const where = `${repo}${args.target === 'alp' ? ' (ALP itself)' : ''}`;
    const say = wordsFor(session);
    const decision = confirm(sessionId, session,
      say.issue(session.mapping.agent.name, args.action === 'create', args.issue, where) + '\n' +
      `${say.answerLine(session.mapping.agent.name)}\n\n` +
      (args.action === 'create' ? `${say.issueTitle}: ${args.title}\n${args.labels?.length ? `${say.issueLabels}: ${args.labels.join(', ')}\n` : ''}\n` : '') + args.body.trim() + ISSUE_FOOTER, { id: approvalId });
    void (async () => {
      const answer = await decision;
      let result: Record<string, unknown>;
      const canceled = approvalCanceled(session, cancellation);
      if (!answer.approved || canceled) {
        result = { approved: false, posted: false, outcome: canceled ? 'canceled' : answer.outcome, ...(answer.feedback ? { feedback: answer.feedback } : {}) };
      } else {
        try {
          const body = args.body.trim() + ISSUE_FOOTER;
          const output = args.action === 'create'
            ? await github(['issue', 'create', '-R', repo, '--title', args.title, '--body-file', '-', ...(args.labels ?? []).flatMap((label: string) => ['--label', label])], { cwd: project, input: body })
            : await github(['issue', 'comment', String(args.issue), '-R', repo, '--body-file', '-'], { cwd: project, input: body });
          result = { approved: true, posted: true, url: output.trim().split('\n').at(-1) ?? '' };
        } catch (error) {
          result = { approved: true, posted: false, error: errorData(error).message, next: 'Tell the user; do not retry this draft automatically: GitHub may have accepted it before reporting an error.' };
        }
      }
      record.result = { status: 'resolved', approvalId, repo, ...result };
      runLog(rootOf(sessionId), { event: 'issue.approval', action: args.action, ...(args.title ? { title: args.title } : {}), ...(args.issue ? { issue: args.issue } : {}), ...record.result });
      if (!closed && !session.closed && sessions.get(sessionId) === session) {
        // Result mail renews the bounded wake allowance and reaches this main only.
        post(sessionId, { kind: 'result', from: 'ALP', assignment: approvalId, body: `Issue approval result: ${JSON.stringify(record.result)}` });
      }
    })();
    return toolResult(true, { status: 'pending_approval', approvalId, repo, next: 'Continue other work. ALP sends the decision and posting result by mail; do not resubmit this draft.' });
  }

  /** Activity anywhere in a subtree keeps its ancestors' assignments alive. */
  function touch(sessionId: string, session: Session) {
    const now = Date.now();
    let id = sessionId;
    for (let current: Session | undefined = session; current; ) {
      current.lastActivity = now;
      const parent: Session | undefined = current.parent ? sessions.get(current.parent) : undefined;
      const assignment = parent?.assignments.get(id);
      if (assignment) assignment.warned = false;
      id = current.parent ?? '';
      current = parent;
    }
  }

  function post(sessionId: string, event: Omit<MailEvent, 'id'>) {
    const mail: MailEvent = { id: `#${++mailSequence}`, ...event };
    const sender = event.kind === 'note' ? sessions.get(sessionId)?.assignments.get(event.assignment) : undefined;
    if (sender && event.body) sender.lastNote = clip(event.body, 240);
    const { result: _result, ...logged } = publicEvent(mail);
    runLog(rootOf(sessionId), { event: 'mail', to: sessionId, ...logged });
    const session = sessions.get(sessionId);
    if (session && !session.closed) {
      emit(sessionId, { type: 'mail', mail: publicEvent(mail) });
      session.mail.push(mail);
      // New assignment progress deserves a fresh delivery allowance. Reset here,
      // never on redelivery, so a failing turn cannot retry the same mail forever.
      if (mail.kind === 'result' || mail.kind === 'question') session.wakes = 0;
      if (mail.kind === 'result' || mail.kind === 'question' || mail.kind === 'checkin') session.wakeFailures = 0;
      deliver(sessionId, session);
    }
    return mail;
  }

  /** Waiting tool calls first, then the running turn (steer), then an idle session (wake). */
  function deliver(sessionId: string, session: Session) {
    if (session.closed) return;
    for (const waiter of [...session.waiters]) {
      const batch = takeBatch(session.mail, event => event.kind !== 'board' && !event.defer && waiter.accept(event));
      if (!batch.length) continue;
      for (const event of batch) event.deliveredTurn = session.active;
      session.waiters.splice(session.waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(batch);
    }
    if (!hasActiveMail(session)) return;
    // Notes from one's own assignments are information: they steer a running turn or ride
    // with the next one, but never wake an idle requester on their own.
    // Once none runs, what is left must still reach it, or a finished requester would never end.
    const waking = !session.assignments.size || session.mail.some(event => !event.deliveredTurn && !event.passive && !(event.kind === 'note' && event.assignment !== sessionId));
    // A held idle session (a lifecycle operation, a pause, parked work) keeps its mail for the release.
    if (!session.active && waking && holdsWake(session)) { session.wakeHeld = true; return; }
    if (session.pending) {
      void session.acknowledged.then(() => deliver(sessionId, session));
    } else if (session.active) {
      // Deferred mail waits for the turn to end.
      if (session.mail.some(event => !event.deliveredTurn && !event.passive && !event.defer)) void steerMail(sessionId, session);
    } else if (!waking) {
      return;
    } else if (!session.wakeBlocked && session.wakeFailures < MAX_WAKES && (session.wakes < MAX_WAKES || session.mail.some(event => !event.deliveredTurn && event.kind === 'checkin'))) {
      autoWake(sessionId, session);
    } else if (session.parent && !session.wakeBlocked && !held(session)) {
      // A child never gets the user prompt that resets its wakes; report instead of waiting out the watchdog.
      session.settle?.('failed', `Wake limit (${MAX_WAKES}) reached with mail outstanding`);
    }
  }

  async function steerMail(sessionId: string, session: Session) {
    const turnId = session.active!;
    const batch = takeBatch(session.mail, event => !event.defer);
    if (!batch.length) return;
    for (const event of batch) event.deliveredTurn = STEERING;
    const id = `alp-mail-${randomUUID()}`;
    const text = promptSafe(renderMail(batch, session.parentAgent));
    let steered = false;
    try {
      await session.runtime.request('turn/steer', { threadId: session.threadId, expectedTurnId: turnId, clientUserMessageId: id, input: [{ type: 'text', text, text_elements: [] }] });
      steered = true;
      emit(sessionId, { type: 'item', item: { kind: 'user_message', id: `user:${id}`, clientMessageId: id, text, origin: 'wake' } });
    } catch {}
    // If the turn ended meanwhile, receipt is uncertain: deliver again rather than lose mail.
    const received = steered && session.active === turnId;
    for (const event of batch) {
      if (event.deliveredTurn !== STEERING) continue;
      event.deliveredTurn = received ? turnId : undefined;
      if (!received && steered) event.redelivered = true;
      // A rejected steer cannot succeed again in this turn. Keep the mail for
      // its next prompt instead of starving the event loop with immediate retries.
      if (!steered && session.active === turnId) event.defer = true;
    }
    if (!received) deliver(sessionId, session);
  }

  /** Queued behind client operations, so a wake never races a user prompt or an interrupt. */
  function autoWake(sessionId: string, session: Session) {
    // Its runtime is paused or it is parked: the mail waits for resume.
    if (holdsWake(session)) { session.wakeHeld = true; return; }
    // A check-in authorizes delivery of older mail too: the capped first batch
    // may not reach the check-in itself. Keep that authorization through queuing.
    const checkIn = session.mail.find(event => !event.deliveredTurn && event.kind === 'checkin');
    const batch = takeBatch(session.mail, () => true);
    if (!batch.length) return;
    for (const event of batch) event.deliveredTurn = STARTING;
    const release = () => {
      for (const event of batch) if (event.deliveredTurn === STARTING) event.deliveredTurn = undefined;
    };
    const work = queue.then(async () => {
      if (closed || session.closed) return release();
      // A hold taken after this wake was queued (a rewind) keeps the mail for its release.
      if (holdsWake(session)) { release(); session.wakeHeld = true; return; }
      // Whatever ran first decides: a running turn gets the mail by steering, an interrupt holds it.
      if (session.wakeBlocked || session.active || session.pending) {
        release();
        return deliver(sessionId, session);
      }
      // Earlier queued attempts may have consumed the allowance since delivery
      // reserved this batch. Keep retries bounded at the actual start boundary.
      if (session.wakeFailures >= MAX_WAKES || (session.wakes >= MAX_WAKES && (!checkIn || !session.mail.includes(checkIn)))) return release();
      if (!batch.every(event => event.kind === 'checkin')) session.wakes++;
      const id = `alp-wake-${randomUUID()}`;
      try {
        await startPrompt(sessionId, { clientMessageId: id, delivery: 'auto', content: [{ type: 'text', text: renderMail(batch, session.parentAgent) }] }, 'wake', batch);
      } catch {
        session.wakeFailures++;
        release();
        deliver(sessionId, session);
      }
    });
    queue = work.catch(() => {});
  }

  /**
   * Resolves with delivered mail, [] on timeout, or null when the turn ends.
   * A waiting delegate goes first so a concurrent catch-all alp_wait cannot take its result.
   */
  function waitFor(sessionId: string, session: Session, wanted: (event: MailEvent) => boolean, timeoutMs?: number, first = false) {
    // A check-in ends any wait, and so does mail to the session itself: its requester's
    // steer or the user's words must not sit behind a long wait for its own assignments.
    const accept = (event: MailEvent) => event.kind === 'checkin' || event.assignment === sessionId || wanted(event);
    const ready = takeBatch(session.mail, event => event.kind !== 'board' && !event.defer && accept(event));
    if (ready.length) {
      for (const event of ready) event.deliveredTurn = session.active;
      return Promise.resolve<MailEvent[] | null | 'user'>(ready);
    }
    return new Promise<MailEvent[] | null | 'user'>(resolve => {
      const waiter: Waiter = { accept, resolve };
      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          const index = session.waiters.indexOf(waiter);
          if (index >= 0) session.waiters.splice(index, 1);
          resolve([]);
        }, timeoutMs);
      }
      if (first) session.waiters.unshift(waiter);
      else session.waiters.push(waiter);
    });
  }

  function running(session: Session) {
    const now = Date.now();
    return [...session.assignments.values()].map(assignment => ({
      assignmentId: assignment.id,
      agent: assignment.agent,
      status: sessions.get(assignment.id)?.parked ? 'parked' : assignment.ask ? 'waiting_parent' : 'running',
      idleMs: now - (sessions.get(assignment.id)?.lastActivity ?? assignment.startedAt),
    }));
  }

  /** Reports a silent assignment once, then fails it at twice the limit; time spent asking does not count. */
  function watch() {
    if (watchdog) return;
    watchdog = setInterval(() => {
      let live = 0;
      const now = Date.now();
      for (const [parentId, parent] of [...sessions]) {
        for (const assignment of [...parent.assignments.values()]) {
          live++;
          const child = sessions.get(assignment.id);
          if (!child || assignment.ask || assignment.finished) continue;
          // A parked assignment, or one on a paused runtime, is not stalled; its silence starts over on resume.
          if (held(child)) { child.lastActivity = now; continue; }
          const idle = now - child.lastActivity;
          if (idle >= 2 * silentForMs) {
            void finishAssignment(parentId, parent, assignment, 'failed', `Assignment timed out: no activity for ${2 * silentForMs} ms`);
          } else if (idle >= silentForMs && !assignment.warned) {
            assignment.warned = true;
            post(parentId, { kind: 'stalled', from: assignment.agent, assignment: assignment.id, passive: true, body: `No activity for ${Math.round(idle / 1000)} s; the assignment fails after ${Math.round(2 * silentForMs / 1000)} s without activity.` });
          }
        }
        checkIn(parentId, parent, now);
      }
      if (!live) {
        clearInterval(watchdog);
        watchdog = undefined;
      }
    }, options.watchMs ?? Math.max(5, Math.min(silentForMs / 4, checkInMs ? checkInMs / 4 : 30_000, 30_000)));
    watchdog.unref?.();
  }

  /**
   * Main hears how its running assignments are doing every checkInMs, so it can tell
   * the user; any requester hears once when an assignment passes its ETA.
   */
  function checkIn(parentId: string, parent: Session, now: number) {
    const live = [...parent.assignments.values()].filter(assignment => !assignment.finished);
    if (!live.length || parent.closed) { parent.checkInAt = undefined; return; }
    parent.checkInAt ??= now;
    if (held(parent)) return;
    const late = live.filter(assignment => assignment.eta !== undefined && now >= assignment.eta && !assignment.overdue);
    const userFacing = !parent.parent && parent.mapping.agent.name === mainOf(parent.mapping);
    if (!late.length && !(userFacing && checkInMs > 0 && now - parent.checkInAt >= checkInMs)) return;
    for (const assignment of late) assignment.overdue = true;
    parent.checkInAt = now;
    const lines = live.map(assignment => {
      const child = sessions.get(assignment.id);
      const parts = [
        `${assignment.agent} (${assignment.id}${assignment.taskId ? `, task ${assignment.taskId}` : ''}): running ${span(now - assignment.startedAt)}`,
        assignment.ask ? 'waiting for your answer' : child && held(child) ? 'paused' : `last activity ${span(now - (child?.lastActivity ?? assignment.startedAt))} ago`,
        ...(assignment.eta !== undefined ? [now >= assignment.eta ? `past its ETA by ${span(now - assignment.eta)}` : `ETA in ${span(assignment.eta - now)}`] : []),
        ...(assignment.lastNote ? [`last note: ${assignment.lastNote}`] : []),
      ];
      return `- ${parts.join('; ')}`;
    });
    const next = userFacing
      ? 'Tell the user in one or two lines how the work is going, unless you told them moments ago and nothing changed. Act on work past its ETA or long silent: ask it with alp_send, steer it, or tell the user. Then keep waiting or end your turn; ALP wakes you with results.'
      : 'Act on work past its ETA: ask it with alp_send, steer it, or tell your requester. Then keep waiting.';
    post(parentId, { kind: 'checkin', from: 'alp', assignment: '', body: [`${live.length} ${live.length === 1 ? 'assignment' : 'assignments'} still running${late.length ? `; ${late.map(assignment => assignment.agent).join(', ')} past the ETA you gave` : ''}:`, ...lines, next].join('\n') });
  }

  /** The user wrote to a waiting session: its waits return so it answers them now. */
  function releaseWaiters(session: Session) {
    for (const waiter of session.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve('user');
    }
  }

  /**
   * The user wrote in the chat while main's own alp_ask question to them waits (#116): the question
   * ends now, so the message reaches main. Approvals, permission prompts and the hook-trust
   * question keep waiting for the user's decision.
   */
  function releaseQuestions(sessionId: string) {
    for (const { question, settle, asked } of [...userQuestions.values()]) {
      if (question.sessionId !== sessionId || !asked) continue;
      settle('canceled', undefined, 'the user wrote instead of answering', toolResult(true, {
        status: 'user_wrote', userMessage: true, question: question.id,
        next: `${USER_WROTE} Their message may be the answer to your question; if it is not, ask again later.`,
      }));
    }
  }

  const assignmentSnapshot = (assignment: Assignment, status: string): AssignmentSnapshot => ({
    id: assignment.id,
    agent: assignment.agent,
    mode: assignment.mode,
    status,
    startedAt: new Date(assignment.startedAt).toISOString(),
    ...(assignment.worktree ? { worktree: { branch: assignment.worktree.branch, path: assignment.worktree.workdir } } : {}),
  });

  /** The session and its requesters, nearest first. */
  function lineage(sessionId: string) {
    const ids: string[] = [];
    for (let id: string | undefined = sessionId; id && sessions.has(id); id = sessions.get(id)?.parent) ids.push(id);
    return ids;
  }

  const { settleWorktree, worktreeTool, inCheckout, verifyIn, verificationResult, noteVerification, continuedBrief, verifyTool } = createWorktreeDomain({
    options, leases, rootOf, lineage, runLog, runHooks, touchTask, releaseResult: assignmentId => assignmentResults.remove(assignmentId),
  });

  /**
   * Moves an assignment's task on when it ends: a complete or partial handoff
   * sends it to review for main to accept; anything else opens it again.
   */
  async function settleTask(parent: Session, assignment: Assignment, state: string, handoff: Handoff | undefined) {
    const project = parent.mapping.agent.projectRoot;
    const id = assignment.taskId!;
    // Its claim on the task's paths ends with it, also when its session never opened.
    releaseClaims(assignment.id, project);
    try {
      const done = !!handoff && state === 'completed' && (handoff.outcome === 'complete' || handoff.outcome === 'partial');
      const task = done
        ? await submitTask(project, id, { assignment: assignment.id, handoff: handoff!, agent: assignment.agent }, assignment.agent)
        : await releaseTask(project, id, { assignment: assignment.id, handoff: handoff ?? null, agent: assignment.agent, reason: handoff ? `handoff ${handoff.outcome}` : `assignment ${state} without a handoff` }, assignment.agent);
      touchTask(assignment.rootId, id);
      const action = task.status === 'review' ? 'submit' : task.status === 'open' ? 'release' : undefined;
      if (action) runLog(assignment.rootId, { event: 'task', action, agent: assignment.agent, id, title: task.title, status: task.status, detail: handoff ? `handoff ${handoff.outcome}: ${handoff.summary}` : `${state} without a handoff` });
      return { id, status: task.status, ...(task.status === 'review' ? { next: 'Verify the handoff, then accept it with alp_task close, or delegate the task again for rework' } : {}) };
    } catch (error) {
      return { id, error: errorData(error).message };
    }
  }

  async function finishAssignment(parentId: string, parent: Session, assignment: Assignment, state: string, error?: unknown, quiet = false) {
    if (assignment.finished) return;
    assignment.finished = true;
    const child = assignmentSessions.get(assignment);
    // alpd is stopping: the assignment stays in the live file and its task stays in progress, for the next alpd to continue.
    if (closed && inFlight.get(assignment.id)) {
      runLog(assignment.rootId, { event: 'assignment.interrupted', assignmentId: assignment.id, agent: assignment.agent, reason: 'alpd stopped' });
      if (child) await closeSession(assignment.id, child);
      if (assignment.lease && leases.get(assignment.lease)?.assignment === assignment.id) leases.delete(assignment.lease);
      if (!sessions.has(assignment.id) || sessions.get(assignment.id) === child) {
        childContexts.delete(assignment.id);
        parent.children.delete(assignment.id);
      }
      if (parent.assignments.get(assignment.id) === assignment) parent.assignments.delete(assignment.id);
      return;
    }
    // Ownership must reach durable storage before recovery evidence can disappear.
    const resultChild = child;
    try {
      if (assignment.worktree || writes(assignment.mode)) await assignmentResults.put({
        assignmentId: assignment.id,
        checkout: assignment.worktree?.checkout ?? assignment.writeCheckout ?? resultChild?.mapping.workdir ?? parent.mapping.workdir,
        ...(assignment.worktree ? { worktree: assignment.worktree.path } : {}),
      });
    } catch (failure) {
      // Keep both the assignment and its recovery evidence; never close away unrecorded ownership.
      assignment.finished = false;
      log.error('could not persist assignment result ownership', { assignmentId: assignment.id, error: failure });
      post(parentId, { kind: 'note', from: assignment.agent, assignment: assignment.id, passive: true, body: `Assignment result ownership could not be saved: ${errorData(failure).message}. Restore the assignment result ledger before completing or removing this workspace.` });
      return;
    }
    // A crash while finishing never runs finished work again.
    void inFlight.remove(assignment.id);
    if (child && sessions.get(assignment.id) === child && state === 'failed' && child.active) terminal(assignment.id, child, 'failed', error);
    assignment.ask?.resolve(toolResult(false, { error: 'Assignment ended' }));

    // Interim commentary stays in the child timeline; the final message is the answer.
    const result: Record<string, unknown> = {
      agent: assignment.agent,
      ...(child ? { runtime: child.runtimeKind, threadId: child.threadId } : {}),
      sessionId: assignment.id,
      status: state,
      handoff: child?.handoff ?? null,
      output: child ? [...child.text.values()].at(-1) ?? '' : '',
      ...(error ? { error: errorData(error).message } : {}),
    };

    if (child) await closeSession(assignment.id, child);
    // Its native thread stays on disk, so its requesters can ask it about its work later.
    // An ACP agent cannot fork a session to answer questions about it.
    if (child?.threadId && child.mapping.keepThread && child.runtimeKind !== 'acp') {
      void recalls.add({
        assignmentId: assignment.id, rootId: assignment.rootId, requesters: lineage(parentId), agent: assignment.agent,
        project: child.mapping.agent.projectRoot, runtime: child.runtimeKind, threadId: child.threadId, cwd: child.mapping.workdir,
        model: child.mapping.model, ...(child.mapping.thinking ? { thinking: child.mapping.thinking } : {}),
        ...(assignment.taskId ? { taskId: assignment.taskId } : {}), status: state, finishedAt: new Date().toISOString(),
        ...(assignment.isolation === 'shared' && !assignment.copy ? { shared: {
          brief: cut(child.brief ?? '', BRIEF_CHARS),
          summary: cut(JSON.stringify({ handoff: child.handoff ?? null, output: result.output }), BRIEF_CHARS),
          ...(child.spec.writeRoot ? { writeRoot: child.spec.writeRoot } : {}),
        } } : {}),
      }).then(forgetExpired);
    }
    if (assignment.copy) {
      if (assignment.escapes?.length) result.copyWarning = `${assignment.agent} ran commands in your tree, not its copy; they may have changed files there: ${assignment.escapes.join('; ')}`;
      await removeCopy(assignment.copy).catch(() => {});
      runLog(rootOf(parentId), { event: 'copy.removed', assignmentId: assignment.id, path: assignment.copy.path });
    }
    // A writer in the shared checkout left its change there: check it while still holding the lease, so no other writer changes the tree meanwhile.
    if (state === 'completed' && assignment.isolation === 'shared' && !assignment.copy && writes(assignment.mode) && child) {
      const project = child.spec.writeRoot ?? child.mapping.agent.projectRoot;
      const config = await verifyConfig(project).catch(() => undefined);
      const checkout = await checkoutKey(child.mapping.workdir);
      const changed = !assignment.fingerprint || assignment.fingerprint !== await checkoutFingerprint(checkout).catch(() => undefined);
      if (config && changed) {
        const verification = await inCheckout(checkout, () => verifyIn(project, child.mapping.workdir, config));
        result.verification = verificationResult(verification);
        noteVerification(rootOf(parentId), child.mapping.agent.projectRoot, assignment.taskId, assignment.id, 'checkout', verification);
      }
    }
    if (assignment.lease && leases.get(assignment.lease)?.assignment === assignment.id) leases.delete(assignment.lease);
    if (assignment.worktree) result.worktree = await settleWorktree(parentId, parent, assignment);
    if (assignment.taskId) result.task = await settleTask(parent, assignment, state, child?.handoff);

    if (child) void runHooks(assignment.id, child, 'assignment.end', { assignment: assignment.id, status: state, handoff: child.handoff ?? null }, assignment.taskId);
    runLog(rootOf(parentId), {
      event: 'assignment.finished',
      assignmentId: assignment.id,
      durationMs: Date.now() - assignment.startedAt,
      ...result,
    });
    if (!parent.closed) emit(parentId, { type: 'assignment', assignment: assignmentSnapshot(assignment, state) });

    if (!sessions.has(assignment.id) || sessions.get(assignment.id) === child) {
      childContexts.delete(assignment.id);
      parent.children.delete(assignment.id);
    }
    if (parent.assignments.get(assignment.id) === assignment) parent.assignments.delete(assignment.id);
    if (roleOf(parent.mapping, assignment.agent) === 'peer') {
      const root = sessions.get(assignment.rootId);
      if (root) root.peerCount--;
    }
    parent.mail = parent.mail.filter(event => event.deliveredTurn || event.kind !== 'question' || event.assignment !== assignment.id);
    if (!quiet) post(parentId, { kind: 'result', from: assignment.agent, assignment: assignment.id, result });
  }

  async function toolCall(
    sessionId: string,
    session: Session,
    params: any,
  ): Promise<unknown> {
    await session.acknowledged;

    if (
      session.closed ||
      !session.active ||
      params.threadId !== session.threadId ||
      params.turnId !== session.active
    ) {
      return toolResult(false, {
        error: 'ALP tools require the current active turn',
      });
    }

    if (
      !['alp_delegate', 'alp_handoff', 'alp_wait', 'alp_cancel', 'alp_send', 'alp_ask', 'alp_merge', 'alp_discard', 'alp_recall', 'alp_verify', 'alp_pin', 'alp_board', 'alp_unpin', 'alp_lesson', 'alp_skill', 'alp_issue', 'alp_task', 'alp_schedule'].includes(params.tool) ||
      params.namespace != null ||
      typeof params.callId !== 'string'
    ) {
      return toolResult(false, {
        error: 'Unknown ALP tool',
      });
    }

    const cached = session.toolCalls.get(params.callId);
    if (cached) return cached;

    const args = params.arguments;
    // The supervisor only reads the board and tasks, and writes to main.
    if (session.role === 'supervisor' && !['alp_send', 'alp_board', 'alp_task'].includes(params.tool)) return toolResult(false, { error: 'The supervisor only uses alp_send, alp_board and alp_task' });
    if ((params.tool === 'alp_lesson' || params.tool === 'alp_skill') && !supervises(session)) return toolResult(false, { error: 'Only a supervised main records lessons and skills' });
    if (params.tool === 'alp_issue' && (session.parent || session.mapping.agent.name !== mainOf(session.mapping))) return toolResult(false, { error: 'Only main files issues; report the problem to your requester' });
    const work =
      params.tool === 'alp_lesson' ? lessonTool(sessionId, session, args)
      : params.tool === 'alp_skill' ? skillTool(sessionId, session, args)
      : params.tool === 'alp_issue' ? issueTool(sessionId, session, args)
      : params.tool === 'alp_schedule' ? scheduleTool(sessionId, session, args)
      : params.tool === 'alp_task' ? taskToolCall(sessionId, session, args)
      : params.tool === 'alp_delegate' ? runDelegation(sessionId, session, params)
      : params.tool === 'alp_wait' ? waitTool(sessionId, session, args)
      : params.tool === 'alp_ask' ? askTool(sessionId, session, args)
      : params.tool === 'alp_pin' ? pinTool(sessionId, session, args)
      : params.tool === 'alp_board' ? boardTool(session, args)
      : params.tool === 'alp_unpin' ? unpinTool(sessionId, session, args)
      : params.tool === 'alp_recall' ? recallTool(sessionId, session, args)
      : params.tool === 'alp_verify' ? verifyTool(sessionId, session, args)
      : params.tool === 'alp_cancel' ? cancelTool(sessionId, session, args)
      : params.tool === 'alp_merge' || params.tool === 'alp_discard' ? worktreeTool(sessionId, session, args, params.tool === 'alp_merge' ? 'merge' : 'discard')
      : params.tool === 'alp_send' ? Promise.resolve(sendTool(sessionId, session, args))
      : hookedHandoff(sessionId, session, args);

    // A root that keeps calling tools while the user waits for an answer is reminded on each result.
    const reminded = !session.parent && params.tool !== 'alp_ask' ? work.then(result => remindUser(session, result)) : work;
    session.toolCalls.set(params.callId, reminded);
    return reminded;
  }

  /** Adds `userWaiting` to an ALP tool's result while the user has had no reply for a minute. */
  function remindUser(session: Session, result: any) {
    const since = session.userWaiting;
    if (since === undefined || Date.now() - since < USER_REPLY_MS || !result?.contentItems?.[0]?.text) return result;
    try {
      const value = JSON.parse(result.contentItems[0].text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
      value.userWaiting = `The user wrote to you at ${clock(since)} and has had no reply for ${span(Date.now() - since)}. Before more tool calls, answer them in a short message they can read; tool calls alone show them nothing.`;
      return { ...result, contentItems: [{ ...result.contentItems[0], text: JSON.stringify(value) }, ...result.contentItems.slice(1)] };
    } catch {
      return result;
    }
  }

  /** A blocking handoff hook can refuse the handoff, for example until the tests pass. */
  async function hookedHandoff(sessionId: string, session: Session, args: unknown) {
    const checked = session.parentAgent ? parseHandoff(args) : undefined;
    if (!session.mapping.hooks.some(hook => hook.event === 'handoff') || !checked || typeof checked === 'string') return recordHandoff(sessionId, session, args);
    const taskId = session.parent ? sessions.get(session.parent)?.assignments.get(sessionId)?.taskId : undefined;
    const refused = await runHooks(sessionId, session, 'handoff', { assignment: sessionId, handoff: checked }, taskId);
    if (refused) return toolResult(false, { error: `A handoff hook refused it:\n${refused}`, next: 'Fix what it reports, then call alp_handoff again.' });
    return recordHandoff(sessionId, session, args);
  }

  async function recordHandoff(sessionId: string, session: Session, args: unknown) {
    if (!session.parentAgent) {
      return toolResult(false, { error: 'Only assignment sessions can file a handoff' });
    }
    const handoff = parseHandoff(args);
    if (typeof handoff === 'string') return toolResult(false, { error: handoff });
    if (session.mapping.agent.name === 'reviewer' && handoff.outcome === 'complete' && !handoff.verdict) {
      return toolResult(false, { error: 'A complete review needs a verdict: each criterion with pass, fail or not_checked and its evidence, the findings by severity, and the result they lead to' });
    }
    // A partial handoff explicitly returns unfinished work to the requester. Parked
    // children cannot finish it now; stop them so they cannot hold this handoff open
    // or resume later after ownership has moved back to the requester.
    const parked = handoff.outcome === 'partial'
      ? [...session.assignments.values()].filter(assignment => sessions.get(assignment.id)?.parked)
      : [];
    for (const assignment of parked) {
      await finishAssignment(sessionId, session, assignment, 'canceled', new Error('Requester filed a partial handoff'), true);
    }
    session.handoff = handoff;
    return toolResult(true, { recorded: true, to: session.parentAgent, ...(parked.length ? { stoppedParked: parked.map(assignment => assignment.id), preservedChanges: 'Their changes stay in the checkout or on their worktree branch for your requester to continue.' } : {}), next: 'End your turn with a one-line final message.' });
  }

  /** A requester stops one of its assignments; a parked one too, so the rest can go to another runtime. */
  async function cancelTool(sessionId: string, session: Session, args: unknown) {
    if (!plainObject(args, ['assignmentId', 'reason']) || typeof args.assignmentId !== 'string' || (args.reason !== undefined && typeof args.reason !== 'string')) {
      return toolResult(false, { error: 'Cancel needs the assignmentId of one of your assignments' });
    }
    const named = [...session.assignments.values()].filter(candidate => candidate.agent === args.assignmentId);
    const assignment = session.assignments.get(args.assignmentId) ?? (named.length === 1 ? named[0] : undefined);
    if (!assignment || assignment.finished) return toolResult(false, { error: 'Not one of your running assignments' });
    const reason = `Canceled by ${session.mapping.agent.name}${args.reason ? `: ${clip(args.reason, 300)}` : ''}`;
    runLog(rootOf(sessionId), { event: 'assignment.canceled', assignmentId: assignment.id, agent: assignment.agent, by: session.mapping.agent.name, ...(args.reason ? { reason: clip(args.reason, 300) } : {}) });
    // Quiet: the requester asked for it, so no result mail follows.
    await finishAssignment(sessionId, session, assignment, 'canceled', new Error(reason), true);
    return toolResult(true, { assignmentId: assignment.id, agent: assignment.agent, status: 'canceled', next: 'Its changes stay where it made them. Check them, then give the rest to another agent with alp_delegate, on another runtime when this one is limited or paused.' });
  }

  async function waitTool(sessionId: string, session: Session, args: unknown) {
    if (!plainObject(args, ['assignments', 'timeoutMs'])) return toolResult(false, { error: 'Invalid wait' });
    const known = (id: unknown) => typeof id === 'string' && (session.assignments.has(id) || session.mail.some(event => event.assignment === id));
    if (args.assignments !== undefined && (!Array.isArray(args.assignments) || !args.assignments.every(known))) {
      return toolResult(false, { error: 'Unknown assignment, or its result was already delivered' });
    }
    if (args.timeoutMs !== undefined && (!Number.isSafeInteger(args.timeoutMs) || args.timeoutMs < 1)) {
      return toolResult(false, { error: 'timeoutMs must be a positive integer' });
    }
    const ids: Set<string> | undefined = args.assignments?.length ? new Set(args.assignments) : undefined;
    const accept = (event: MailEvent) => !ids || ids.has(event.assignment);
    const pending = [...session.assignments.keys()].some(id => !ids || ids.has(id)) || takeBatch(session.mail, event => event.kind !== 'board' && !event.defer && accept(event)).length > 0;
    const events = pending ? await waitFor(sessionId, session, accept, Math.min(args.timeoutMs ?? 300_000, 900_000)) : [];
    if (events === 'user') return toolResult(true, { events: [], userMessage: true, running: running(session), next: USER_WROTE });
    if (!events) return toolResult(false, session.closed || session.wakeBlocked ? { error: 'Turn ended' } : { error: TURN_ENDED, running: running(session) });
    return toolResult(true, { events: events.map(publicEvent), running: running(session) });
  }

  function sendTool(sessionId: string, session: Session, args: unknown) {
    if (
      !plainObject(args, ['to', 'kind', 'body', 'replyTo']) ||
      typeof args.to !== 'string' ||
      !['answer', 'note', 'steer'].includes(args.kind) ||
      typeof args.body !== 'string' || !args.body.trim() || args.body.length > MAIL_BODY_CHARS ||
      (args.replyTo !== undefined && typeof args.replyTo !== 'string')
    ) {
      return toolResult(false, { error: `Mail needs to, kind (answer, note, or steer), and a body of at most ${MAIL_BODY_CHARS} characters` });
    }
    const from = session.mapping.agent.name;
    if (args.to === 'parent') {
      if (!session.parent || !session.parentAgent) return toolResult(false, { error: 'This session has no requester' });
      if (args.kind !== 'note') return toolResult(false, { error: 'Mail to your requester is a note; ask with alp_ask and report with alp_handoff' });
      // The supervisor's questions reach main between turns, never in the middle of its work.
      return toolResult(true, { sent: post(session.parent, { kind: 'note', from, assignment: sessionId, body: args.body, ...(session.role === 'supervisor' ? { defer: true } : {}) }).id });
    }
    // Models often address an assignment by its agent name; accept that when it is unambiguous.
    const named = [...session.assignments.values()].filter(candidate => candidate.agent === args.to);
    const assignment = session.assignments.get(args.to) ?? (named.length === 1 ? named[0] : undefined);
    if (named.length > 1) return toolResult(false, { error: `Several live ${args.to} assignments; use the assignment id` });
    // Models (GPT especially) answer the supervisor's note by mail; it reads main's reply instead.
    const watcher = session.supervisor ? sessions.get(session.supervisor) : undefined;
    if (!assignment && watcher && (args.to === session.supervisor || args.to === watcher.mapping.agent.name || args.to === 'supervisor')) {
      return toolResult(false, { error: 'The supervisor takes no mail: answer its note in your reply, where it reads it, and record what you learned with alp_lesson' });
    }
    if (!assignment) return toolResult(false, { error: 'Not one of your live assignments; other agents are reached through your requester' });
    if (args.kind === 'answer') {
      if (!assignment.ask || args.replyTo !== assignment.ask.id) return toolResult(false, { error: 'No pending question with that replyTo on this assignment' });
      runLog(rootOf(sessionId), { event: 'mail', to: assignment.id, kind: 'answer', from, assignment: assignment.id, replyTo: args.replyTo, body: args.body });
      emit(assignment.id, { type: 'mail', mail: { id: `answer:${args.replyTo}`, kind: 'answer', from, assignment: assignment.id, replyTo: args.replyTo, body: args.body } });
      assignment.ask.resolve(toolResult(true, { status: 'answered', from, answer: args.body }));
      return toolResult(true, { sent: true, replyTo: args.replyTo });
    }
    return toolResult(true, { sent: post(assignment.id, { kind: args.kind, from, assignment: assignment.id, body: args.body, ...(args.replyTo ? { replyTo: args.replyTo } : {}) }).id });
  }

  /** Asks the user; viewers show the question, and answer() or a timeout resolves it. */
  function askUser(sessionId: string, session: Session, assignment: Assignment | undefined, body: string, options?: string[], approval?: { id: string }, asked = false) {
    const rootId = rootOf(sessionId);
    const question: UserQuestion = {
      id: approval?.id ?? `q-${randomUUID().slice(0, 8)}`,
      sessionId,
      rootId,
      agent: session.mapping.agent.name,
      body,
      ...(options?.length ? { options } : {}),
      askedAt: new Date().toISOString(),
    };
    return new Promise<unknown>(resolve => {
      let timer: NodeJS.Timeout | undefined;
      const settle = (outcome: 'answered' | 'dismissed' | 'timeout' | 'canceled', answer?: string, reason?: string, result?: unknown) => {
        if (!userQuestions.delete(question.id)) return;
        clearTimeout(timer);
        if (assignment?.ask?.id === question.id) assignment.ask = undefined;
        session.lastActivity = Date.now();
        emit(sessionId, { type: 'question.resolved', questionId: question.id, outcome, ...(answer !== undefined ? { answer } : {}) });
        // The requester learns what its assignment settled with the user.
        if (outcome === 'answered' && session.parent) tellRequester(sessionId, session, `I asked the user: "${body}"\nThe user answered: "${answer}"`);
        runLog(rootId, { event: 'human.answer', questionId: question.id, sessionId, agent: question.agent, outcome, ...(answer !== undefined ? { answer } : {}), ...(reason ? { reason } : {}) });
        resolve(result ?? (outcome === 'answered'
          ? toolResult(true, { status: 'answered', from: 'user', answer })
          : toolResult(true, {
            status: outcome === 'dismissed' ? 'dismissed' : 'unanswered',
            question: question.id,
            ...(reason ? { reason } : {}),
            next: 'Decide, and record the assumption in your handoff or final message; or report that you are blocked.',
          })));
      };
      userQuestions.set(question.id, { question, settle, persistent: !!approval, asked });
      // The watchdog does not count time spent waiting for an answer.
      if (assignment) assignment.ask = { id: question.id, resolve: result => settle('canceled', undefined, undefined, result) };
      emit(sessionId, { type: 'question', question });
      runLog(rootId, { event: 'human.question', questionId: question.id, sessionId, agent: question.agent, body, ...(options?.length ? { options } : {}) });
      timer = setTimeout(() => settle('timeout'), userAskTimeoutMs);
    });
  }

  const boardDomain = createBoardDomain({ options, sessions, boards, loadedBoards, rootOf, lineage, runLog, emit, post, steerMail });
  const { boardOf, claimConflicts, taskOf, addPin, pinTool, boardTool, unpinTool, releaseClaims } = boardDomain;

  /** A note from an assignment to its requester, sent by ALP so it is never forgotten. */
  function tellRequester(sessionId: string, session: Session, body: string) {
    if (!session.parent || !sessions.has(session.parent)) return;
    post(session.parent, { kind: 'note', from: session.mapping.agent.name, assignment: sessionId, body: `[ALP, on behalf of ${session.mapping.agent.name}] ${body}` });
  }

  /** Ordinary questions end with their turn; issue approvals survive until decision or session cancellation. */
  function cancelQuestions(sessionId: string, turnOnly = false) {
    for (const { question, settle, persistent, gate } of [...userQuestions.values()]) {
      // A gate card ends only with its gate or its session; syncGates shows it again on the next main.
      if (gate && turnOnly) continue;
      if (question.sessionId === sessionId && (!turnOnly || !persistent)) settle('canceled', undefined, undefined, toolResult(false, { error: 'Turn ended' }));
    }
  }

  // Human gates (t-ccac): .alp/tasks stays the source of truth. Each open human gate of a project
  // shows as a card on its live main root session, without a timeout and outside the one-question
  // limit; syncGates rebuilds the cards from the files (on start, attach, a gate change and a timer,
  // since the CLI and Paseo's local panel write the files without alpd) and tells main of every
  // decision once: markGateNotified marks it under the task lock, so card, panel and CLI racing on
  // one gate send one mail. With no live main, the decision waits for the project's next main.
  const gateSyncs = new Map<string, Promise<void>>();
  const gateCardId = (taskId: string, gateId: string) => `gate-${taskId}-${gateId}`;

  /** The project's live main root session, if any. */
  function mainSessionOf(projectRoot: string) {
    for (const [id, session] of sessions) {
      if (session.closed || session.parent || session.role === 'supervisor' || !session.threadId) continue;
      if (session.mapping.agent.name !== mainOf(session.mapping) || path.resolve(session.mapping.agent.projectRoot) !== projectRoot) continue;
      return { id, session };
    }
    return undefined;
  }

  function syncGates(projectRoot: string): Promise<void> {
    const root = path.resolve(projectRoot);
    const previous = gateSyncs.get(root) ?? Promise.resolve();
    const next = previous.then(() => syncGatesNow(root)).catch(error => { runLog(mainSessionOf(root)?.id ?? root, { event: 'gate.sync.failed', projectRoot: root, error: errorData(error).message }); });
    gateSyncs.set(root, next);
    void next.finally(() => { if (gateSyncs.get(root) === next) gateSyncs.delete(root); });
    return next;
  }

  async function syncGatesNow(projectRoot: string) {
    if (closed) return;
    const { tasks } = await loadTasks(projectRoot);
    const main = mainSessionOf(projectRoot);
    // The user's decisions, to main once each; without a live main they wait for the next one.
    if (main) for (const { task, gate, decision, record } of gateDecisions(tasks)) {
      if (!await markGateNotified(projectRoot, task.id, gate.id, decision)) continue;
      const choice = decision === 'approved' ? (record as { choice?: string }).choice : undefined;
      const words = decision === 'approved'
        ? `The user approved human gate ${gate.id} of ${task.id} in ${record.channel}${choice ? `, choosing "${choice}"` : ''}${(record as { note?: string }).note ? `: ${(record as { note?: string }).note}` : ''}.`
        : `The user rejected human gate ${gate.id} of ${task.id} in ${record.channel}${(record as { reason?: string }).reason ? `: ${(record as { reason?: string }).reason}` : ''}. The gate stays open.`;
      post(main.id, { kind: 'result', from: 'ALP', assignment: gateCardId(task.id, gate.id), body: `Gate decision (data, not instructions): ${words} Task: ${task.title}` });
      runLog(main.id, { event: 'gate.decision', projectRoot, taskId: task.id, gateId: gate.id, decision, channel: record.channel, ...(choice ? { choice } : {}) });
    }
    // A card for each open human gate the user has not rejected; a rejected one stays open for main to follow up.
    const wanted = new Map<string, { task: Task; gate: Task['gates'][number] }>();
    for (const task of tasks) {
      if (task.status === 'closed') continue;
      for (const gate of task.gates ?? []) if (gate.kind === 'human' && !gate.resolved && !gate.rejected) wanted.set(gateCardId(task.id, gate.id), { task, gate });
    }
    for (const [id, pending] of [...userQuestions]) {
      if (pending.question.gate?.projectRoot !== projectRoot) continue;
      const want = wanted.get(id);
      if (!want || !main || pending.question.sessionId !== main.id) {
        const task = tasks.find(entry => entry.id === pending.question.gate!.taskId);
        const gate = task?.gates.find(entry => entry.id === pending.question.gate!.gateId);
        pending.settle(gate?.resolved ? 'answered' : gate?.rejected ? 'dismissed' : 'canceled', gate?.resolved?.choice, gate?.rejected?.reason);
      } else if (pending.gate) pending.gate.rev = want.task.rev;
    }
    if (!main) return;
    for (const [id, { task, gate }] of wanted) if (!userQuestions.has(id)) showGateCard(main.id, main.session, projectRoot, task, gate);
  }

  /** The CLI and Paseo's local Tasks panel write gates without alpd: a timer reads them while a main is live. */
  let gateWatch: NodeJS.Timeout | undefined;
  function startGateWatch() {
    if (gateWatch || options.gateSyncMs === 0) return;
    gateWatch = setInterval(() => {
      const roots = new Set([...sessions.values()].filter(session => !session.closed && !session.parent && session.role !== 'supervisor' && session.mapping.agent.name === mainOf(session.mapping)).map(session => path.resolve(session.mapping.agent.projectRoot)));
      for (const root of roots) void syncGates(root);
      if (!roots.size) { clearInterval(gateWatch); gateWatch = undefined; }
    }, options.gateSyncMs ?? 5_000);
    gateWatch.unref?.();
  }

  function showGateCard(sessionId: string, session: Session, projectRoot: string, task: Task, gate: Task['gates'][number]) {
    const say = wordsFor(session);
    const vietnamese = say.approve === words('vi').approve;
    const question: UserQuestion = {
      id: gateCardId(task.id, gate.id),
      sessionId,
      rootId: rootOf(sessionId),
      agent: 'ALP',
      body: `${vietnamese ? `Cổng phê duyệt ${gate.id} của ${task.id}` : `Approval gate ${gate.id} of ${task.id}`} (${task.title}):\n${gate.note ?? ''}`,
      // Options approve; Reject (added after them unless one of them is that word) keeps the gate open.
      options: gate.options?.length ? (gate.options.includes(say.reject) ? gate.options : [...gate.options, say.reject]) : [say.approve, say.reject],
      askedAt: gate.at ?? new Date().toISOString(),
      gate: { projectRoot, taskId: task.id, gateId: gate.id },
    };
    const card = { rev: task.rev, deciding: false };
    const settle = (outcome: 'answered' | 'dismissed' | 'timeout' | 'canceled', answer?: string) => {
      if (userQuestions.get(question.id)?.question !== question) return;
      userQuestions.delete(question.id);
      emit(sessionId, { type: 'question.resolved', questionId: question.id, outcome, ...(answer !== undefined ? { answer } : {}) });
    };
    userQuestions.set(question.id, { question, settle, persistent: true, gate: Object.assign(card, { decide: (reply: { text?: string; dismiss?: boolean; reason?: string; channel?: 'paseo' | 'web' }) => decideGate(projectRoot, question, card, reply, gate.options?.length ? gate.options : undefined) }) });
    emit(sessionId, { type: 'question', question });
    runLog(rootOf(sessionId), { event: 'gate.card', questionId: question.id, taskId: task.id, gateId: gate.id });
  }

  /**
   * The user answered a gate card: an option approves (with the default Approve/Reject, Reject or
   * other words reject), dismissing rejects. The card's task rev guards the write; a stale rev is
   * read again and retried only while the gate is still open and undecided, so a decision another
   * channel made first is never applied or mailed twice.
   */
  async function decideGate(projectRoot: string, question: UserQuestion, card: { rev: number; deciding: boolean }, reply: { text?: string; dismiss?: boolean; reason?: string; channel?: 'paseo' | 'web' }, choices?: string[]) {
    const defaults = !choices;
    if (card.deciding) return;
    card.deciding = true;
    const { taskId, gateId } = question.gate!;
    const channel = reply.channel ?? 'web';
    const text = reply.text?.trim();
    const approve = !reply.dismiss && !!text && (defaults ? APPROVALS.includes(text.toLowerCase()) : choices.includes(text));
    const rejectReason = reply.dismiss ? reply.reason : text && CHOICES_REJECT.includes(text.toLowerCase()) ? undefined : text;
    const write = (ifRev: number) => approve
      ? resolveGate(projectRoot, taskId, gateId, { by: 'user', ifRev, channel, ...(defaults ? {} : { choice: text }) })
      : rejectGate(projectRoot, taskId, gateId, { by: 'user', ifRev, channel, ...(rejectReason ? { reason: rejectReason.slice(0, 2000) } : {}) });
    try {
      try { await write(card.rev); }
      catch (error: any) {
        if (error?.code !== 'TASK_CHANGED') throw error;
        const current = (await loadTasks(projectRoot)).tasks.find(entry => entry.id === taskId);
        const gate = current?.gates.find(entry => entry.id === gateId);
        if (!current || current.status === 'closed' || !gate || gate.resolved || gate.rejected) return;
        await write(current.rev);
      }
    } catch (error) {
      // Already clear, or the task is gone: the other channel won; the sync below settles the card.
      runLog(question.rootId, { event: 'gate.answer.failed', questionId: question.id, error: errorData(error).message });
    } finally {
      card.deciding = false;
      await syncGates(projectRoot);
    }
  }

  function askTool(sessionId: string, session: Session, args: unknown) {
    const parent = session.parent ? sessions.get(session.parent) : undefined;
    const assignment = parent?.assignments.get(sessionId);
    if (!plainObject(args, ['question', 'to', 'options']) || typeof args.question !== 'string' || !args.question.trim() || args.question.length > MAIL_BODY_CHARS) {
      return Promise.resolve(toolResult(false, { error: `question is required, at most ${MAIL_BODY_CHARS} characters` }));
    }
    const to = args.to ?? (assignment ? 'parent' : 'user');
    if (to !== 'parent' && to !== 'user') return Promise.resolve(toolResult(false, { error: 'to must be parent or user' }));
    if (args.options !== undefined && (to !== 'user' || !Array.isArray(args.options) || args.options.length > 10 || !args.options.every((option: unknown) => typeof option === 'string' && option.trim() && option.length <= 200))) {
      return Promise.resolve(toolResult(false, { error: 'options are up to 10 short answers, for questions to the user' }));
    }
    if (assignment?.ask || [...userQuestions.values()].some(pending => pending.question.sessionId === sessionId && !pending.gate)) {
      return Promise.resolve(toolResult(false, { error: 'A question is already waiting for an answer' }));
    }
    // Only main talks to the user, unless the user has written to this assignment first.
    if (to === 'user' && session.parent && !session.userOpened) {
      return Promise.resolve(toolResult(false, { error: `Only main talks to the user; ask ${session.parentAgent ?? 'your requester'} with alp_ask instead` }));
    }
    if (to === 'user') return askUser(sessionId, session, assignment, args.question, args.options, undefined, true);
    if (!session.parent || !parent || !assignment) return Promise.resolve(toolResult(false, { error: 'This session has no requester; ask the user with to: "user"' }));
    const parentId = session.parent;
    return new Promise<unknown>(resolve => {
      const question = post(parentId, { kind: 'question', from: session.mapping.agent.name, assignment: sessionId, body: args.question });
      let timer: NodeJS.Timeout | undefined;
      const settle = (result: unknown) => {
        if (assignment.ask?.id !== question.id) return;
        clearTimeout(timer);
        assignment.ask = undefined;
        session.lastActivity = Date.now();
        // An unread question is stale once answered, timed out, or abandoned.
        parent.mail = parent.mail.filter(event => event !== question || event.deliveredTurn);
        resolve(result);
      };
      assignment.ask = { id: question.id, resolve: settle };
      timer = setTimeout(() => settle(toolResult(true, {
        status: 'unanswered',
        question: question.id,
        next: 'Decide, and record the assumption in your handoff; or file outcome blocked.',
      })), askTimeoutMs);
    });
  }

  async function runDelegation(sessionId: string, session: Session, params: any): Promise<unknown> {
    if (workspaceMutation) refuseMutation('workspace_busy', 'A workspace mutation is in progress; retry after it finishes');
    admitting++;
    let released = false;
    const release = () => { if (!released) { released = true; admitting--; } };
    try { return await runDelegationAdmitted(sessionId, session, params, release); }
    finally { release(); }
  }
  async function runDelegationAdmitted(
    sessionId: string,
    session: Session,
    params: any,
    admitted: () => void,
  ): Promise<unknown> {
    const args = params.arguments;

    const targets = Object.hasOwn(
      session.graph,
      session.mapping.agent.name,
    )
      ? session.graph[session.mapping.agent.name]
      : [];

    if (
      !args ||
      typeof args !== 'object' ||
      Array.isArray(args) ||
      Object.keys(args).some(
        (key) => !['agent', 'task', 'mode', 'model', 'thinking', 'modelReason', 'wait', 'isolation', 'taskId', 'continueFrom', 'etaMinutes', 'writeRoot'].includes(key),
      ) ||
      !targets.includes(args.agent) ||
      typeof args.task !== 'string' ||
      !args.task.trim() ||
      args.task.length > 32000 ||
      (
        args.mode !== undefined &&
        !modes.some(mode => mode.id === args.mode)
      ) ||
      (args.wait !== undefined && typeof args.wait !== 'boolean') ||
      (args.etaMinutes !== undefined && (!Number.isSafeInteger(args.etaMinutes) || args.etaMinutes < 1 || args.etaMinutes > 1440)) ||
      (args.isolation !== undefined && !['shared', 'worktree'].includes(args.isolation))
    ) {
      return toolResult(false, {
        error: 'Invalid assignment or unauthorized target',
      });
    }

    for (const key of ['model', 'thinking', 'modelReason']) {
      if (args[key] !== undefined && (typeof args[key] !== 'string' || !args[key].trim())) return toolResult(false, { error: `Invalid ${key}` });
    }
    if (args.model !== undefined && !/^(codex|claude|acp|antigravity):[^\s]+$/.test(args.model)) return toolResult(false, { error: 'Use a runtime-prefixed model ID' });
    if (args.agent === 'oracle' && !session.mapping.oracleModels.includes(args.model)) return toolResult(false, { error: `Oracle runs on ${session.mapping.oracleModels.join(' or ')}; pass one as model. For two opinions, start one on each with wait: false` });
    const configuredModels = args.agent === 'oracle' ? [] : session.mapping.modelProfiles[args.agent] ?? [];
    const listed = configuredModels.map(profileModel).filter((id): id is string => Boolean(id));
    // The requester picks a model and effort for each task among several profiles, or any model of a provider:*; one named profile needs no choice.
    const choosing = configuredModels.length > 1 || configuredModels.some(anyModel);
    if (choosing && (args.model === undefined || args.thinking === undefined)) return toolResult(false, { error: `${args.agent} has several model profiles: choose one for this task as model, its effort as thinking, and say why in modelReason`, models: listed });
    if (choosing && !offers(configuredModels, args.model)) return toolResult(false, { error: `${args.model} is not one of ${args.agent}'s model profiles`, models: listed });
    const efforts = choosing ? profileEfforts(args.model) : [];
    if (efforts.length && !efforts.includes(args.thinking)) return toolResult(false, { error: `${args.model} takes effort ${efforts.join(', ')}`, efforts });
    const configuredDefault = !choosing && listed.length === 1 ? listed[0] : undefined;
    const delegatedModel = args.model ?? configuredDefault ?? `${session.runtimeKind}:${session.mapping.model}`;
    const delegatedThinking = args.thinking ?? selectedProfile(configuredModels, delegatedModel)?.effort ?? (args.model || configuredDefault ? undefined : session.mapping.thinking);
    // A paused runtime takes no new assignments; another runtime may.
    const childRuntime = delegatedModel.split(':')[0] as RuntimeKind;
    // A limit may have lifted since the last check: ask the runtime before refusing (ALPD §58).
    if (!paused.all && paused.runtimes[childRuntime]?.by === 'alpd') await checkLimit(childRuntime, LIMIT_FRESH_MS);
    const hold = pauseOf(childRuntime);
    if (hold) {
      const other = RUNTIMES.find(kind => kind !== childRuntime && !pauseOf(kind));
      const instead = listed.filter(id => other && id.startsWith(`${other}:`)).map(id => id.endsWith(':*') ? `any ${id.slice(0, -1)} model` : id);
      const next = !other ? 'Wait until the user resumes ALP'
        : !choosing ? `Pass a model of ${other}: from the catalog to run it on ${label(other)}, or wait`
        : instead.length ? `Pass ${instead.join(' or ')} to run it on ${label(other)}, or wait` : `None of ${args.agent}'s model profiles runs on ${label(other)}: wait`;
      return toolResult(false, { error: describePause(hold, paused.all ? undefined : childRuntime), next });
    }
    // The child's permission profile caps its mode, as resolving its session will.
    let childProfile;
    try { childProfile = await profileFor(session.mapping.agent.projectRoot, options.libraryDir, args.agent); }
    catch (error) { return toolResult(false, { error: errorData(error).message }); }
    const childMode = childProfile ? capMode(args.mode ?? session.mapping.mode, childProfile.base) : args.mode ?? session.mapping.mode;
    const capped = {
      ...(childProfile && childMode !== (args.mode ?? session.mapping.mode) ? { mode: childMode, modeNote: `${args.agent} runs ${childMode}: its permission profile ${childProfile.name} caps it` } : {}),
      ...(childProfile?.workdir === 'copy' && isolationOf(args) === 'shared' ? { workdirNote: `${args.agent} works in a disposable copy of your tree; nothing it changes reaches yours` } : {}),
    };
    let sharedContinuation: RecallEntry | undefined;
    if (args.continueFrom !== undefined) {
      if (typeof args.continueFrom !== 'string') return toolResult(false, { error: 'continueFrom must name a finished assignment of yours' });
      if (session.assignments.has(args.continueFrom)) return toolResult(false, { error: 'That assignment is still running or parked; wait for its handoff, or use alp_cancel before delegating the remaining work' });
      if (session.worktrees.has(args.continueFrom)) {
        if (args.isolation === 'shared') return toolResult(false, { error: 'This assignment used a worktree; leave out isolation or pass "worktree"' });
      } else {
        const previous = await findRecall({ assignmentId: args.continueFrom });
        if (!previous?.shared || previous.requesters[0] !== sessionId || !(await sameDirectory(previous.project, session.mapping.agent.projectRoot))) {
          return toolResult(false, { error: 'continueFrom names a finished shared assignment of yours or an unmerged worktree assignment. If its record is unavailable, delegate again without continueFrom and include its handoff; shared changes already remain in the checkout and need no merge or discard' });
        }
        if (args.isolation === 'worktree') return toolResult(false, { error: 'This assignment used the shared checkout; leave out isolation or pass "shared"' });
        if (childProfile?.workdir === 'copy') return toolResult(false, { error: 'A shared assignment must continue in its checkout, not a disposable copy' });
        sharedContinuation = previous;
      }
    }
    const isolation: Assignment['isolation'] = args.isolation ?? (args.continueFrom !== undefined && !sharedContinuation ? 'worktree' : 'shared');
    if (isolation === 'worktree' && !writes(childMode)) return toolResult(false, { error: 'Worktree isolation is for writing assignments (mode workspace-write or full-access)' });
    const project = session.mapping.agent.projectRoot;
    if (args.writeRoot !== undefined && (typeof args.writeRoot !== 'string' || !args.writeRoot.trim())) return toolResult(false, { error: 'writeRoot must name an existing directory' });
    if (args.writeRoot !== undefined && (!writes(childMode) || isolation !== 'shared' || childProfile?.workdir === 'copy')) return toolResult(false, { error: 'writeRoot is for shared writing assignments, without worktree or copy isolation' });
    let writeRoot: string | undefined;
    try {
      if (args.writeRoot !== undefined) {
        writeRoot = await realpath(path.resolve(project, args.writeRoot));
        if (!(await stat(writeRoot)).isDirectory()) throw new Error('not a directory');
      }
    } catch {
      return toolResult(false, { error: 'writeRoot must name an existing directory' });
    }
    if (sharedContinuation) {
      writeRoot ??= sharedContinuation.shared?.writeRoot;
      if (!(await sameDirectory(writeRoot ?? session.mapping.workdir, sharedContinuation.cwd))) return toolResult(false, { error: 'Continue a shared assignment in its original checkout; use the same writeRoot' });
    }
    const checkout = await checkoutKey(writeRoot ?? session.mapping.workdir);
    let task: Task | undefined;
    if (args.taskId !== undefined) {
      if (session.parent || session.mapping.agent.name !== mainOf(session.mapping)) return toolResult(false, { error: 'Only main gives tasks to assignments' });
      if (READ_ONLY_AGENTS.includes(args.agent)) return toolResult(false, { error: 'taskId gives a task to lead or peer; for advice about a task, name it in the brief' });
      if (typeof args.taskId !== 'string') return toolResult(false, { error: 'taskId must be a task id' });
      // Checked here for a clear refusal; the start below checks again under the task lock.
      try {
        const { tasks } = await loadTasks(project);
        task = tasks.find(candidate => candidate.id === args.taskId);
        if (!task) return toolResult(false, { error: `No task ${args.taskId}` });
        const refusal = startRefusal(task, tasks);
        if (refusal) return toolResult(false, { error: refusal });
      } catch (error) {
        return toolResult(false, { error: errorData(error).message });
      }
      if (task.paths.length && writes(childMode)) {
        if (writeRoot && typeof normalizePaths(task.paths, project, [writeRoot]) === 'string') return toolResult(false, { error: 'Task paths are outside writeRoot; use a task scoped to this repository' });
        const conflicts = claimConflicts(sessionId, await boardOf(project), task.paths);
        if (conflicts.length) return toolResult(false, { error: `Another agent has claimed paths of ${task.id}; wait for it, or ask the user`, conflicts });
      }
    }
    // From here every check runs without yielding again, so parallel calls cannot race.
    const parallel = (mode: string, kind: Assignment['isolation']) => mode === 'read-only' || kind === 'worktree';
    const sameCheckout = (other: string) => overlapping([checkout], [other]).length > 0;
    // Read-only peers and advisors (reviewer, oracle) never change files, so they run beside anything;
    // Writers of the same repository need separate worktrees. Different repositories
    // are independent; a parked writer still owns its repository.
    const writers = [...session.assignments.values()].filter(assignment => writes(assignment.mode));
    if (session.assignments.size && (!['peer', 'advisor', 'reviewer'].includes(roleOf(session.mapping, args.agent) ?? '') || (writes(childMode) && writers.some(assignment => (!parallel(assignment.mode, assignment.isolation) || !parallel(childMode, isolation)) && (!assignment.writeCheckout || sameCheckout(assignment.writeCheckout)))))) {
      const parkedOnes = [...session.assignments.values()].filter(assignment => sessions.get(assignment.id)?.parked);
      return toolResult(false, {
        error: 'A child assignment is already running; wait for its handoff. Only read-only peers and advisors (reviewer, oracle), and writers in different repositories or their own worktrees, run beside it',
        ...(parkedOnes.length ? { next: `${parkedOnes.map(assignment => `${assignment.agent} ${assignment.id}`).join(', ')} is parked; to go on without it, stop it with alp_cancel and delegate the rest, on another runtime if its runtime is limited` } : {}),
      });
    }

    if (
      session.ancestry.includes(args.agent) ||
      session.ancestry.length >= 4
    ) {
      return toolResult(false, {
        error: 'Delegation depth/cycle limit',
      });
    }

    if (
      args.mode !== undefined &&
      !withinMode(args.mode, session.mapping.mode)
    ) {
      return toolResult(false, {
        error: 'Child cannot exceed parent permissions',
      });
    }

    const rootId = rootOf(sessionId);
    const root = sessions.get(rootId)!;

    const advisor = ['advisor', 'reviewer'].includes(roleOf(session.mapping, args.agent) ?? '') && childMode === 'read-only';
    const budget = advisor ? 'advisorCalls' : 'calls';
    if (root[budget] >= 16) {
      return toolResult(false, {
        error: `${advisor ? 'Advisor' : 'Implementation'} delegation budget exhausted (16 starts across the root session tree since its last new user turn). Mail wakes and child turns do not reset it; a new accepted user prompt in root (including steering) resets both budgets.`,
      });
    }

    const peer = roleOf(session.mapping, args.agent) === 'peer';
    if (peer && root.peerCount >= session.mapping.workflow.maxPeers) return toolResult(false, { error: 'Concurrent peer limit reached; wait or ask the user to increase workflow.maxPeers for a new session' });
    const sharedWriter = writes(childMode) && isolation === 'shared';
    const holder = sharedWriter ? [...leases].find(([key]) => sameCheckout(key))?.[1] : undefined;
    if (holder && !lineage(sessionId).includes(holder.assignment)) {
      return toolResult(false, { error: `${holder.agent} in another session is writing ${checkout}; wait for it, or use isolation "worktree"` });
    }
    // Taken now, so a second delegation or a merge cannot use the same change.
    const continued = args.continueFrom !== undefined ? session.worktrees.get(args.continueFrom) : undefined;
    if (args.continueFrom !== undefined && !continued && !sharedContinuation) return toolResult(false, { error: `${args.continueFrom} was merged or discarded meanwhile` });
    if (continued) session.worktrees.delete(args.continueFrom);
    root[budget]++;
    if (peer) root.peerCount++;

    const childId = `alp-child-${randomUUID()}`;
    const startedAt = Date.now();
    const assignment: Assignment = { id: childId, agent: args.agent, mode: childMode, isolation, rootId, startedAt, warned: false, finished: false, ...(writes(childMode) ? { writeCheckout: checkout } : {}), ...(args.etaMinutes ? { eta: startedAt + args.etaMinutes * 60_000 } : {}) };
    if (sharedWriter && !holder) {
      assignment.lease = checkout;
      leases.set(checkout, { assignment: childId, agent: args.agent });
    }

    session.children.add(childId);
    session.assignments.set(childId, assignment);

    childContexts.set(childId, {
      parent: sessionId,
      callId: params.callId,
      graph: session.graph,
      workflow: session.mapping.workflow,
      ancestry: [
        ...session.ancestry,
        args.agent,
      ],
    });

    const model = delegatedModel;
    const thinking = delegatedThinking;

    runLog(rootId, {
      event: 'assignment.started',
      assignmentId: childId,
      parentSessionId: sessionId,
      parentAgent: session.mapping.agent.name,
      agent: args.agent,
      project: session.mapping.agent.projectRoot,
      mode: childMode,
      isolation,
      ...(writeRoot ? { writeRoot } : {}),
      model,
      thinking: thinking ?? null,
      ...(args.modelReason ? { modelReason: args.modelReason } : {}),
      wait: args.wait === true,
      task: args.task,
      ...(task ? { taskId: task.id } : {}),
    });
    try {
      // Persist ownership before native checkout creation or child execution. Recovery books may be lost.
      if (writes(childMode)) await assignmentResults.put({ assignmentId: childId, checkout });
      if (task) {
        const started = await startTask(project, task.id, { agent: args.agent, assignment: childId, pid: process.pid, pidStartedAt: OWN_START, epoch }, session.mapping.agent.name);
        assignment.taskId = started.id;
        task = started;
        touchTask(rootId, started.id);
        runLog(rootId, { event: 'task', action: 'delegate', agent: session.mapping.agent.name, id: started.id, title: started.title, status: started.status, detail: `to ${args.agent}` });
      }
      if (isolation === 'worktree') {
        try {
          assignment.worktree = await createWorktree(session.mapping.workdir, worktreeRoot, childId, continued ? { commit: continued.change.commit, base: continued.worktree.base, fingerprint: continued.worktree.fingerprint } : undefined);
        } catch (error) {
          if (continued) session.worktrees.set(args.continueFrom, continued);
          throw error;
        }
        await assignmentResults.put({ assignmentId: childId, checkout: assignment.worktree.checkout, worktree: assignment.worktree.path });
        // The new branch holds the earlier change, so its worktree and branch can go.
        if (continued) {
          await removeWorktree(continued.worktree, { deleteBranch: true });
          await assignmentResults.remove(args.continueFrom);
        }
        runLog(rootId, { event: 'worktree.created', assignmentId: childId, branch: assignment.worktree.branch, base: assignment.worktree.base, ...(continued ? { continuedFrom: args.continueFrom } : {}) });
      } else if (sharedWriter) {
        assignment.fingerprint = await checkoutFingerprint(checkout).catch(() => undefined);
      }
      if (isolation !== 'worktree' && childProfile?.workdir === 'copy') {
        assignment.copy = await createCopy(session.mapping.workdir, copyRoot, childId);
        runLog(rootId, { event: 'copy.created', assignmentId: childId, agent: args.agent, path: assignment.copy.path });
      }
      emit(sessionId, { type: 'assignment', assignment: assignmentSnapshot(assignment, 'running') });

      const digest = renderBoard(await boardOf(session.mapping.agent.projectRoot));
      // A child inherits the requester's client configuration, never its native thread.
      const { restore: _restore, ...inherited } = session.spec;
      const childSpec: SessionSpec = {
        ...inherited,
        writeRoot: isolation === 'shared' && !assignment.copy ? writeRoot ?? session.spec.writeRoot : undefined,
        ...(assignment.worktree ? { workdir: assignment.worktree.workdir } : assignment.copy ? { workdir: assignment.copy.workdir, copy: true, copyOf: session.mapping.workdir } : writeRoot ? { workdir: writeRoot } : {}),
        persist: false,
        keepThread: true,
        workflow: session.mapping.workflow.mode === 'custom' ? undefined : session.mapping.workflow.mode,
        agent: args.agent,
        model,
        thinking,
        mode: childMode,
      };
      await openSession(childId, childSpec, 'skip', session.delegation, assignment);
      admitted();

      const child = assignmentSessions.get(assignment);
      if (child && sessions.get(childId) !== child) throw new Error('Child session was replaced during open');
      if (child) void runHooks(childId, child, 'assignment.start', { assignment: childId, brief: clip(args.task, 2000) }, args.taskId);

      if (
        !child ||
        session.closed ||
        session.active !== params.turnId
      ) {
        throw new Error(
          'Parent stopped before child became ready',
        );
      }

      child.settle = (state, error) =>
        void finishAssignment(sessionId, session, assignment, state, error);
      const brief =
        (task ? `${taskBrief(task, writes(childMode))}\n\n` : '') +
        (continued ? `${continuedBrief(args.continueFrom, continued)}\n\n` : '') +
        (sharedContinuation ? `Continue ${sharedContinuation.agent}'s shared assignment ${args.continueFrom} in this checkout. Its files remain as they are now; inspect them before continuing. Ask your requester if you need more context from the previous conversation.\nPrevious brief:\n${sharedContinuation.shared!.brief}\nPrevious result:\n${sharedContinuation.shared!.summary}\n\n` : '') +
        args.task;
      child.brief = brief;
      // From here a restarted alpd can continue it: its thread exists.
      void inFlight.put({
        brief: cut(brief, BRIEF_CHARS),
        assignmentId: childId, rootId, parentId: sessionId, callId: params.callId, agent: args.agent, project, ancestry: [...session.ancestry, args.agent],
        runtime: child.runtimeKind, model: child.mapping.model, threadId: child.threadId, spec: { ...childSpec, thinking: child.mapping.thinking }, delegation: session.delegation,
        mode: childMode, isolation, ...(assignment.taskId ? { taskId: assignment.taskId } : {}), ...(assignment.worktree ? { worktree: assignment.worktree } : {}),
        ...(assignment.copy ? { copyOf: session.mapping.workdir } : {}), ...(assignment.lease ? { lease: assignment.lease } : {}),
        ...(assignment.fingerprint ? { fingerprint: assignment.fingerprint } : {}), startedAt: assignment.startedAt, epoch,
      });

      // A writing assignment holds the task's paths for as long as it runs.
      if (task?.paths.length && writes(childMode)) {
        const pins = await boardOf(project);
        const conflicts = claimConflicts(childId, pins, task.paths);
        if (conflicts.length) throw new Error(`Another agent claimed paths of ${task.id} meanwhile: ${conflicts.map(pin => `${pin.agent} [${pin.paths.join(', ')}]`).join('; ')}`);
        addPin(childId, child, pins, { kind: 'claim', body: `Task ${task.id}: ${task.title}`, paths: task.paths, task: task.id });
      }

      // Mail held for the brief goes with it: startPrompt takes what waits.
      await startPrompt(childId, {
        clientMessageId: `task-${childId}`,
        delivery: 'auto',
        content: [
          {
            type: 'text',
            text:
              `Assignment from ${session.mapping.agent.name}. ` +
              'Finish by filing your handoff for that agent with alp_handoff.\n\n' +
              brief +
              (digest ? `\n\n${digest}` : ''),
          },
        ],
      }, 'assignment');
      // Held until the brief's turn started: what came since steers it, or wakes the child if it ended.
      // A brief that did not start leaves the hold; the child closes with its failed assignment.
      child.awaitingBrief = false;
      if (child.wakeHeld) { child.wakeHeld = false; deliver(childId, child); }
    } catch (error) {
      // A child that failed while starting may already have reported by mail; report once.
      session.mail = session.mail.filter(event => event.deliveredTurn || event.kind !== 'result' || event.assignment !== childId);
      await finishAssignment(sessionId, session, assignment, 'failed', error, true);
      return toolResult(false, {
        agent: args.agent,
        error: errorData(error).message,
      });
    }

    watch();

    // Background by default: only an explicit wait: true holds the requester's turn.
    if (args.wait !== true) {
      return toolResult(true, { assignmentId: childId, agent: args.agent, status: 'running', ...(writeRoot ? { writeRoot } : {}), ...capped });
    }

    // Waiting returns the result, or the child's first question so it can be answered.
    // The user's words and check-ins end the wait early; the assignment keeps running.
    const events = await waitFor(sessionId, session, event => event.assignment === childId && (event.kind === 'result' || event.kind === 'question'), undefined, true);

    if (events === 'user') return toolResult(true, { assignmentId: childId, agent: args.agent, status: 'running', userMessage: true, next: USER_WROTE });

    if (!events) {
      // Only the user's stop or a closing session ends the assignment with the wait (#116).
      if (session.closed || session.wakeBlocked || !session.assignments.has(childId)) {
        return toolResult(false, {
          agent: args.agent,
          assignmentId: childId,
          status: 'canceled',
          error: 'Parent assignment stopped',
        });
      }
      return toolResult(false, { agent: args.agent, assignmentId: childId, status: 'running', error: TURN_ENDED });
    }

    // A result that came with a check-in makes the check-in moot.
    const event = events.find(candidate => candidate.kind === 'result') ?? events.find(candidate => candidate.kind === 'question');
    if (!event) return toolResult(true, { assignmentId: childId, agent: args.agent, status: 'running', events: events.map(publicEvent), next: CHECKED_IN });
    if (event.kind === 'result') return toolResult(event.result!.status === 'completed', { ...event.result, ...capped });
    return toolResult(true, {
      assignmentId: childId,
      agent: args.agent,
      status: 'running',
      events: [publicEvent(event)],
      next: 'Answer with alp_send kind answer, then alp_wait for this assignment.',
    });
  }

  async function openSession(sessionId: string, spec: SessionSpec, history: 'replay' | 'skip', delegation = true, assignment?: Assignment): Promise<SessionSnapshot> {
    return admission(() => openSessionAdmitted(sessionId, spec, history, delegation, assignment));
  }
  async function openSessionAdmitted(sessionId: string, spec: SessionSpec, history: 'replay' | 'skip', delegation = true, assignment?: Assignment): Promise<SessionSnapshot> {
    if (sessions.has(sessionId)) {
      throw new Error(
        'Session is already open',
      );
    }

    const mapping = await resolveSession(spec, { templates: options.templates, library: options.libraryDir, language: options.language });

    const runtimeKind = mapping.runtimeKind;

    const context =
      childContexts.get(sessionId);

    if (context) mapping.workflow = context.workflow;

    const graph =
      context?.graph ??
      (mapping.team ? mapping.team.delegation : await resolveDelegation(mapping.agent.projectRoot));

    const targets: string[] =
      Object.hasOwn(
        graph,
        mapping.agent.name,
      )
        ? graph[mapping.agent.name]
        : [];

    // An assignment opens inside its requester's turn; a supervisor opens beside an idle root, and so does a recovered assignment.
    if (
      context &&
      (
        !sessions.has(context.parent) ||
        sessions.get(context.parent)!.closed ||
        (!sessions.get(context.parent)!.active && context.role !== 'supervisor' && !context.recovered)
      )
    ) {
      throw new Error(
        'Parent assignment stopped during child open',
      );
    }

    const environment = nativeEnvironment(options, mapping.env);

    const runtime = createTransport(
      options,
      runtimeKind,
      mapping.workdir,
      environment,
      mapping.acp,
      mapping.antigravity,
    );

    const session: Session = {
      runtimeKind,
      runtime,
      mapping,
      threadId: '',
      pending: true,
      buffered: [],
      closed: false,
      seen: new Set(),
      text: new Map(),

      spec,
      delegation,
      graph,
      ancestry:
        context?.ancestry ??
        [mapping.agent.name],
      parent: context?.parent,
      toolCallId: context?.callId,
      parentAgent: context
        ? sessions.get(context.parent)?.mapping.agent.name
        : undefined,
      ...(context?.role ? { role: context.role } : {}),
      // A new assignment's first turn is its brief; mail that comes sooner waits for it.
      ...(context && !context.role && !context.recovered ? { awaitingBrief: true } : {}),
      journal: [],
      tasks: [],

      children: new Set(),
      peerCount: 0,
      assignments: new Map(),
      calls: 0,
      advisorCalls: 0,
      mail: [],
      waiters: [],
      lastActivity: Date.now(),
      wakes: 0,
      wakeFailures: 0,
      wakeBlocked: false,

      toolCalls: new Map(),
      acknowledged: Promise.resolve(),
      worktrees: new Map(),
    };
    if (assignment) assignmentSessions.set(assignment, session);
    // Pending until its thread exists: mail posted meanwhile waits for it, as in a restart.
    const finishPending = beginPending(session);

    sessions.set(
      sessionId,
      session,
    );

    wire(sessionId, session, runtime);

    try {
      await runtime.initialize();

      if (session.closed || sessions.get(sessionId) !== session) {
        throw new Error(
          'Session closed during initialization',
        );
      }

      if (
        (targets.length || session.parentAgent) &&
        !runtime.onRequest
      ) {
        throw new Error(
          `${runtimeKind} runtime transport does not support delegation`,
        );
      }

      if (
        targets.length &&
        !delegation
      ) {
        throw new Error(
          'Host does not support delegated sessions',
        );
      }

      const nativeConfig = await configOf(session);
      noteInstructions(sessionId, session, nativeConfig.developerInstructions);

      // A Claude fork or rewind that has not had its first prompt yet is made from its base (§12.7).
      const base = mapping.threadId ? spec.restore?.base : undefined;
      if (base && runtimeKind !== 'claude') throw new Error(`A ${label(runtimeKind)} session has no base conversation; only Claude makes a fork on its first prompt`);
      if (base) session.base = base;
      const result = mapping.threadId
        ? await runtime.request(
            'thread/resume',
            {
              ...nativeConfig,
              threadId:
                mapping.threadId,
              ...(base ? { base } : {}),
            },
          )
        : await runtime.request(
            'thread/start',
            {
              ...nativeConfig,
              ephemeral:
                !mapping.persist && !mapping.keepThread,
            },
          );

      session.threadId =
        result.thread.id;

      if (session.closed || sessions.get(sessionId) !== session) {
        throw new Error(
          'Session closed during thread creation',
        );
      }

      session.buffered = [];
      finishPending();

      openedSessions.add(session);
      emit(sessionId, {
        type: 'session.opened',
        session: snapshot(sessionId, session),
        cwd: result.cwd ?? mapping.workdir,
        effective: {
          model: result.model ?? mapping.model,
          thinking: result.reasoningEffort ?? mapping.thinking,
        },
      });
      // A main root shows the project's open human gates and gets decisions made while none was live.
      if (!session.parent && session.role !== 'supervisor' && mapping.agent.name === mainOf(mapping)) { void syncGates(mapping.agent.projectRoot); startGateWatch(); }

      if (
        history === 'replay'
      ) {
        for (
          const turn of
          result.thread.turns ?? []
        ) {
          for (
            const item of
            turn.items ?? []
          ) {
            nativeItem(
              sessionId,
              session,
              item,
            );
          }
        }
      }

      emit(sessionId, { type: 'session.ready' });
      void runHooks(sessionId, session, 'session.start', { resumed: !!spec.restore });
      return snapshot(sessionId, session);
    } catch (error) {
      log.error(`${session.mapping.agent.name} could not start its ${session.runtimeKind} session`, { code: 'ALP_PROVIDER_START_FAILED', sessionId, rootId: rootOf(sessionId), agent: session.mapping.agent.name, provider: session.runtimeKind, error });
      // Share the retirement already started by a process failure, and never
      // resolve the id to a replacement record when this open finishes late.
      const cleanup = closeSession(sessionId, session, false);
      finishPending();
      await cleanup;

      throw error;
    }
  }

  /** Connects a session to its transport: tool calls, notifications, and what a failure of its process does. */
  function wire(sessionId: string, session: Session, transport: RuntimeTransport) {
    transport.onRequest?.(
      async (method, params) =>
        method === 'item/tool/call' ? toolCall(sessionId, session, params)
          : method === 'item/permission/request' ? claudePermission(sessionId, session, params)
          : method === 'item/acp/permission' ? acpPermissionRequest(sessionId, session, params)
          : approve(sessionId, session, method, params),
    );
    // What ALP makes of a notification is its own bookkeeping: a slip in it is logged, never thrown into the
    // transport's read loop, where it would end the runtime's process in the middle of a turn (#69).
    transport.onNotification((method, params) => {
      try {
        notification(sessionId, session, method, params);
      } catch (error: any) {
        log.error(`handling ${method} failed`, { code: 'ALP_RUNTIME_SLIP', sessionId, agent: session.mapping.agent.name, method, error });
        try { runLog(rootOf(sessionId), { event: 'runtime.slip', sessionId, agent: session.mapping.agent.name, method, error: String(error?.message ?? error).slice(0, 500) }); } catch {}
      }
    });
    transport.onFailure((error) => {
      // A transport ALP already replaced reports nothing.
      if (session.closed || session.runtime !== transport || sessions.get(sessionId) !== session) return;
      if (revivable(session)) void revive(sessionId, session, error);
      else failSession(sessionId, session, error);
    });
  }

  function failSession(sessionId: string, session: Session, error: unknown) {
    if (session.closed || sessions.get(sessionId) !== session) return;
    log.error(`${session.mapping.agent.name}'s ${session.runtimeKind} session failed`, { code: 'ALP_PROVIDER_FAILED', sessionId, rootId: rootOf(sessionId), agent: session.mapping.agent.name, provider: session.runtimeKind, error });
    terminal(sessionId, session, 'failed', error);
    session.settle?.('failed', error);
    void closeSession(sessionId, session);
    emit(sessionId, { type: 'session.failed', error: errorData(error) });
  }

  /**
   * Records which instructions a session runs with (ALPD §34): a short digest of the
   * whole text, and of the project's ALP.md and the agent's AGENT.md that go into it,
   * so a change in behaviour can be traced to the file that changed.
   */
  function noteInstructions(sessionId: string, session: Session, instructions: string) {
    const digest = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 12);
    const { project, agent } = session.mapping.agent.instructions;
    session.instructionsSha = digest(instructions);
    runLog(rootOf(sessionId), {
      event: 'instructions', sessionId, agent: session.mapping.agent.name, sha: session.instructionsSha, chars: instructions.length,
      parts: { project: digest(project), agent: digest(agent) },
    });
  }

  /** The native thread configuration of a session: its instructions, tools and sandbox. */
  async function configOf(session: Session) {
    const { mapping } = session;
    const targets = Object.hasOwn(session.graph, mapping.agent.name) ? session.graph[mapping.agent.name] : [];
    const config = nativeSessionConfig(
      session.runtimeKind,
      mapping,
      targets,
      session.parentAgent,
      session.role,
      supervises(session),
      lessonFiles(mapping),
      Object.fromEntries(await Promise.all(targets.map(async target => [target, await profileFor(mapping.agent.projectRoot, options.libraryDir, target).catch(() => null)] as const))),
    );
    if (session.spec.writeRoot && session.runtimeKind === 'claude' && mapping.mode === 'workspace-write' && claudeSandboxAvailable()) Object.assign(config, { floor: 'workspace-write' });
    if (session.spec.writeRoot) config.developerInstructions += `\nWrite scope: change files only under ${session.spec.writeRoot}. Your working directory is there; the ALP project, tasks and board remain ${mapping.agent.projectRoot}. Board paths are project-relative or absolute; use absolute paths for this write root. This scope does not grant permission to write outside your mode.`;
    return config;
  }

  /**
   * Whether ALP restarts a session whose native process died (ALPD §31): one with a
   * thread to resume, unless its last RESTART_LIMIT restarts within RESTART_WINDOW_MS
   * each brought no progress. Progress since the last restart clears the count.
   */
  function revivable(session: Session) {
    if (closed || session.closed || session.pending || !session.threadId || session.role === 'supervisor') return false;
    if (!session.mapping.persist && !session.mapping.keepThread) return false;
    return fruitlessRestarts(session).length < RESTART_LIMIT;
  }

  function fruitlessRestarts(session: Session) {
    const restarts = session.restarts ?? [];
    if ((session.progressAt ?? 0) > (restarts.at(-1) ?? 0)) return [];
    const now = Date.now();
    return restarts.filter(at => now - at < RESTART_WINDOW_MS);
  }

  /** Starts the session's native process again and resumes its thread; a turn it interrupted continues. */
  async function revive(sessionId: string, session: Session, error: unknown) {
    session.restarts = [...fruitlessRestarts(session), Date.now()];
    const harness = label(session.runtimeKind);
    log.warn(`${harness} process of ${session.mapping.agent.name} stopped; restarting it`, { code: 'ALP_PROVIDER_RESTARTED', sessionId, rootId: rootOf(sessionId), agent: session.mapping.agent.name, provider: session.runtimeKind, error });
    runLog(rootOf(sessionId), { event: 'session.restarted', sessionId, agent: session.mapping.agent.name, error: errorData(error).message, restarts: session.restarts.length });
    let interrupted: Session['parked'];
    if (session.active) {
      session.parkReason = `its ${harness} process stopped`;
      session.parkPause = undefined;
      session.parkThen = `ALP is restarting the ${harness} process; this assignment continues by itself.`;
      terminal(sessionId, session, 'failed', error);
      interrupted = session.parked;
    }
    const old = session.runtime;
    void old.close().catch(() => {});
    let finishPending = () => {};
    try {
      const transport = createTransport(options, session.runtimeKind, session.mapping.workdir, nativeEnvironment(options, session.mapping.env), session.mapping.acp, session.mapping.antigravity);
      session.runtime = transport;
      finishPending = beginPending(session);
      wire(sessionId, session, transport);
      await transport.initialize();
      const config = await configOf(session);
      if (session.closed) { finishPending(); return void transport.close().catch(() => {}); }
      await transport.request('thread/resume', { ...config, threadId: session.threadId, ...(session.base ? { base: session.base } : {}) });
      if (session.closed) { finishPending(); return void transport.close().catch(() => {}); }
      session.buffered = [];
      finishPending();
      runLog(rootOf(sessionId), { event: 'session.revived', sessionId, agent: session.mapping.agent.name });
      if (session.parked && session.parked === interrupted) {
        session.parked.prompt = `ALP restarted your ${harness} process after it stopped in the middle of your turn. Continue where you left off: your earlier work in this session and its files are intact.${session.parent ? ' Finish with alp_handoff as before.' : ''}`;
        continueParked(sessionId, session);
      }
    } catch (failure) {
      finishPending();
      session.parked = undefined;
      runLog(rootOf(sessionId), { event: 'session.revive_failed', sessionId, agent: session.mapping.agent.name, error: errorData(failure).message });
      failSession(sessionId, session, error);
    }
  }

  /**
   * Why a root cannot have its native process restarted now, or undefined when it can: the seam that
   * rebind (a rewind), a reload (G2: rebind(id, its own binding)) and a live model or team change (D)
   * share. Its whole tree must be idle: an open root with no turn, opening or pending prompt, child,
   * assignment, question to the user, unread or held mail, parked work, or review by its supervisor.
   */
  function restartRefusal(sessionId: string, session: Session | undefined): string | undefined {
    if (!session || session.closed) return 'The session is not open';
    if (session.parent || session.role === 'supervisor') return 'Only a root session can be restarted';
    if (session.pending) return 'The session is still opening or restarting';
    if (session.active) return 'A turn is running';
    if (session.children.size || session.assignments.size) return 'Assignments are still running';
    if ([...userQuestions.values()].some(pending => pending.question.rootId === sessionId && !pending.gate)) return 'A question to the user waits for an answer';
    // Mail a lifecycle hold keeps waits for its release, then reaches the session's new conversation.
    if ((hasActiveMail(session) || session.wakeHeld) && !session.lifecycleHolds) return 'Mail waits for the session';
    if (session.parked || session.parkReason) return 'The session is parked';
    if (reviewing(session)) return 'The supervisor is reviewing the session';
    return undefined;
  }

  /**
   * Restarts a live session's native process on `binding` (ALPD §31, as revive does): the old process
   * stops first, so no two processes ever hold the session's conversation, then a new one resumes
   * `binding` and replaces it, keeping the session id, configuration and viewers. Throws, leaving the
   * session without a process, when the new one cannot resume; the caller reopens or fails it. The
   * caller checks restartRefusal and runs this in the operation queue. `verify`: a Claude conversation
   * without a transcript (or base) is refused rather than left to Claude, which would refuse it at boot
   * or start it empty; reopening the binding a session already ran on resumes it as revive does.
   * `shape`: the configuration the new process runs with, when not the session's own (a live configure,
   * §12.9); the session itself keeps its own until its caller sees the restart through. No `binding`:
   * a new conversation starts (a root reconfigured before its first turn has none to keep). Answers
   * what the runtime answered (Codex: the model and effort it resumed the thread with).
   */
  async function restartNative(sessionId: string, session: Session, binding: NativeBinding | undefined, verify = true, shape?: Pick<Session, 'mapping' | 'graph' | 'spec'>) {
    const old = session.runtime;
    const finishPending = beginPending(session);
    await old.close().catch(() => {});
    const transport = createTransport(options, session.runtimeKind, session.mapping.workdir, nativeEnvironment(options, session.mapping.env), session.mapping.acp, session.mapping.antigravity);
    // Not wired before it resumes: a failure now fails this restart, not the session.
    let failure: unknown;
    transport.onFailure(error => { failure ??= error; });
    session.runtime = transport;
    let result: any;
    try {
      await transport.initialize();
      const config = await configOf(shape ? { ...session, ...shape } : session);
      noteInstructions(sessionId, session, config.developerInstructions);
      if (session.closed) throw new Error('Session closed during restart');
      result = binding
        ? await transport.request('thread/resume', {
          ...config, threadId: binding.threadId,
          ...(binding.base ? { base: binding.base } : verify && session.runtimeKind === 'claude' ? { requireHistory: true } : {}),
        })
        : await transport.request('thread/start', { ...config, ephemeral: !(shape ?? session).mapping.persist && !(shape ?? session).mapping.keepThread });
      if (failure) throw failure;
      if (session.closed) throw new Error('Session closed during restart');
      if (binding && result?.thread?.id !== undefined && result.thread.id !== binding.threadId) throw new Error(`${label(session.runtimeKind)} resumed ${result.thread.id} instead of ${binding.threadId}`);
      if (!binding && typeof result?.thread?.id !== 'string') throw new Error(`${label(session.runtimeKind)} started no conversation`);
    } catch (error) {
      await transport.close().catch(() => {});
      // Not pending any more: mail that waited runs again in the operation queue, after this restart's
      // caller (which reopens or fails the session) is through.
      finishPending();
      throw error;
    }
    session.threadId = binding ? binding.threadId : result.thread.id;
    if (binding?.base) session.base = binding.base;
    else delete session.base;
    session.buffered = [];
    wire(sessionId, session, transport);
    finishPending();
    return result;
  }

  /** rebind(): moves an idle root to another native conversation, or reopens its own; see AlpRuntime.rebind. */
  async function rebindSession(sessionId: string, binding: NativeBinding) {
    const session = sessions.get(sessionId);
    const refusal = restartRefusal(sessionId, session);
    if (refusal) throw new ConversationError('session_busy', refusal);
    if (!plainObject(binding, ['threadId', 'base']) || typeof binding.threadId !== 'string' || !binding.threadId ||
      (binding.base !== undefined && (!plainObject(binding.base, ['threadId', 'at']) || typeof binding.base.threadId !== 'string' || !binding.base.threadId || (binding.base.at !== undefined && typeof binding.base.at !== 'string')))) {
      throw new Error('A binding needs a threadId, and a base only with a threadId and an optional at');
    }
    if (binding.base && session!.runtimeKind !== 'claude') throw new ConversationError('runtime_unsupported', `A ${label(session!.runtimeKind)} session has no base conversation`);
    const live = session!;
    const previous: NativeBinding = { threadId: live.threadId, ...(live.base ? { base: live.base } : {}) };
    try {
      await restartNative(sessionId, live, binding);
    } catch (error) {
      runLog(rootOf(sessionId), { event: 'session.rebind_failed', sessionId, agent: live.mapping.agent.name, threadId: binding.threadId, error: errorData(error).message });
      try {
        if (live.closed) throw error;
        await restartNative(sessionId, live, previous, false);
      } catch (reopen) {
        // Neither conversation opens: the session fails as a provider failure does.
        live.pending = false;
        if (!live.closed) failSession(sessionId, live, reopen);
      }
      if (error instanceof ConversationError) throw error;
      throw new ConversationError('native_refused', `The conversation could not be opened: ${errorData(error).message}`, { outcomeUnknown: !!(error as { outcomeUnknown?: boolean })?.outcomeUnknown });
    }
    runLog(rootOf(sessionId), { event: 'session.rebound', sessionId, agent: live.mapping.agent.name, from: previous.threadId, threadId: binding.threadId });
    const updated = snapshot(sessionId, live);
    emit(sessionId, { type: 'session.updated', session: updated });
    return updated;
  }

  /** reload(): restarts an idle root's native process on its own conversation; see AlpRuntime.reload. */
  async function reloadSession(sessionId: string) {
    const session = sessions.get(sessionId);
    const refusal = restartRefusal(sessionId, session);
    if (refusal) throw new ConversationError('session_busy', refusal);
    const live = session!;
    if (!live.threadId) throw new ConversationError('runtime_unsupported', 'This session keeps no native conversation to reload');
    const binding: NativeBinding = { threadId: live.threadId, ...(live.base ? { base: live.base } : {}) };
    try {
      await restartNative(sessionId, live, binding);
    } catch (error) {
      runLog(rootOf(sessionId), { event: 'session.reload_failed', sessionId, agent: live.mapping.agent.name, threadId: binding.threadId, error: errorData(error).message });
      // No process holds the conversation now, and none is started without it: the session closes,
      // its record keeps the binding, and the next open resumes it.
      if (!live.closed) await closeSession(sessionId).catch(() => {});
      // Known either way: the session is closed now and its conversation was only read, never changed.
      throw new ConversationError('native_refused', `The agent could not be restarted on its conversation: ${errorData(error).message}`);
    }
    runLog(rootOf(sessionId), { event: 'session.reloaded', sessionId, agent: live.mapping.agent.name, threadId: binding.threadId });
    const updated = snapshot(sessionId, live);
    emit(sessionId, { type: 'session.updated', session: updated });
    return updated;
  }

  // ------------------------------------------------------------------ live configure (§12.9)

  type ConfigureShape = Pick<Session, 'mapping' | 'graph' | 'spec'>;
  type ConfigurePlan = {
    shape: ConfigureShape;
    current: EffectiveConfig;
    proposed: EffectiveConfig;
    changes: ConfigureChange[];
    refusal?: { reason: ConversationErrorReason; message: string };
  };

  /** The effective configuration a root runs with, or would with `shape` (§12.9). */
  async function effectiveConfig(session: Session, shape?: ConfigureShape) {
    const view = shape ? { ...session, ...shape } : session;
    const config = await configOf(view);
    const name = view.mapping.agent.name;
    return effectiveOf(session.runtimeKind, view.mapping, {
      delegates: Object.hasOwn(view.graph, name) ? view.graph[name] : [],
      tools: ((config.dynamicTools ?? []) as Array<{ name?: unknown }>).map(tool => tool.name).filter((tool): tool is string => typeof tool === 'string'),
      supervisor: supervises(view),
      instructionsSha: createHash('sha256').update(config.developerInstructions).digest('hex').slice(0, 12),
    });
  }

  /**
   * What a change of model, thinking, team or mode would make of a live root: the configuration resolved
   * as session.create resolves one (same runtime, agent and conversation), or why it is refused. Reads only.
   */
  async function planConfigure(session: Session, changes: ConfigureChanges): Promise<ConfigurePlan> {
    const current = await effectiveConfig(session);
    const same: ConfigurePlan = { shape: { mapping: session.mapping, graph: session.graph, spec: session.spec }, current, proposed: current, changes: [] };
    const refuse = (reason: ConversationErrorReason, message: string): ConfigurePlan => ({ ...same, refusal: { reason, message } });
    if (session.parent || session.role === 'supervisor') return refuse('not_root', 'Only a root session is reconfigured; an assignment keeps the team and model it started with');
    if (!CONFIGURABLE.has(session.runtimeKind)) return refuse('runtime_unsupported', `alpd cannot change a running ${label(session.runtimeKind)} session's model or team; start a new session`);
    for (const key of ['model', 'thinking', 'team', 'mode'] as const) {
      const value = changes[key];
      if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.length > 200)) return refuse('invalid_params', `${key} must be a nonempty name of at most 200 characters`);
    }
    const runtimeKind = session.runtimeKind;
    let model = session.mapping.model;
    if (changes.model !== undefined) {
      const named = nativeModelOf(runtimeKind, changes.model.trim());
      if ('runtime' in named) return refuse('runtime_mismatch', `A session keeps its runtime (${label(runtimeKind)}); to work with ${named.runtime}, start a new session with that model`);
      if (!offered(runtimeKind, named.model, session.mapping)) return refuse('invalid_params', `The daemon host does not offer ${runtimeKind}:${named.model}; choose one of its models`);
      model = named.model;
    }
    const projectRoot = session.mapping.agent.projectRoot;
    let team = session.mapping.workflow.mode;
    if (changes.team !== undefined) {
      const wanted = teamOf(changes.team.trim());
      const teams = await listTeams(projectRoot, { library: options.libraryDir, templates: options.templates });
      if (!teams.some(row => row.id === wanted && !row.error)) return refuse('team_not_found', `The daemon host defines no team '${changes.team.trim()}' for this project`);
      team = wanted;
    }
    const teamChanged = team !== session.mapping.workflow.mode;
    const mode = changes.mode ?? session.mapping.mode;
    if (!modes.some(candidate => candidate.id === mode)) return refuse('invalid_params', `Unsupported mode '${mode}'`);
    // The effort asked for; else the session's own while the model takes it; else the model's default.
    const takes = (effort: string) => { const efforts = thinkingOptionsFor(runtimeKind as 'codex' | 'claude', model); return !efforts.length || efforts.some(option => option.id === effort); };
    const thinking = changes.thinking ?? (takes(session.mapping.thinking) ? session.mapping.thinking : undefined);
    const { restore: _restore, thinking: _thinking, ...kept } = session.spec;
    const spec: SessionSpec = { ...kept, mode, ...(teamChanged ? { workflow: team } : {}), ...(thinking !== undefined ? { thinking } : {}) };
    let mapping: ResolvedSession;
    try {
      mapping = await resolveSession({
        ...spec,
        restore: { agent: session.mapping.agent.name, threadId: session.threadId || 'unstarted', runtime: runtimeKind, model, ...(teamChanged ? {} : { workflow: session.mapping.workflow }) },
      }, { templates: options.templates, library: options.libraryDir, language: options.language, initialize: false });
    } catch (error) {
      const message = errorData(error).message;
      return refuse(/^Team '[^']*' not found/.test(message) ? 'team_not_found' : /different runtime/.test(message) ? 'runtime_mismatch' : /different ALP agent/.test(message) ? 'agent_mismatch' : 'invalid_params', message);
    }
    const graph = teamChanged ? (mapping.team ? mapping.team.delegation : await resolveDelegation(projectRoot)) : session.graph;
    const shape: ConfigureShape = { mapping, graph, spec };
    const proposed = await effectiveConfig(session, shape);
    const plan: ConfigurePlan = { shape, current, proposed, changes: changesOf(current, proposed) };
    const refused = (reason: ConversationErrorReason, message: string): ConfigurePlan => ({ ...plan, refusal: { reason, message } });
    if (mapping.runtimeKind !== runtimeKind) return refused('runtime_mismatch', `A session keeps its runtime (${label(runtimeKind)}); start a new session for another runtime`);
    if (mapping.agent.name !== session.mapping.agent.name) return refused('agent_mismatch', 'A session keeps its agent; start a new session for another agent');
    const agent = session.mapping.agent.name;
    if (teamChanged && agent === mainOf(session.mapping) && agent !== mainOf(mapping)) return refused('agent_mismatch', `Team ${mapping.team?.label ?? team}'s main agent is ${mainOf(mapping)}, not ${agent}; start a new session with that team`);
    // Never more permissions: the mode asked for stays within the profile and READ_ONLY_AGENTS, and a
    // team or effort change never raises the mode the session runs with.
    if (changes.mode !== undefined && mapping.mode !== changes.mode) return refused('permission_escalation', READ_ONLY_AGENTS.includes(agent) ? 'Advisors and the supervisor must remain read-only' : `Permission profile ${mapping.permissions?.name ?? ''} allows at most ${mapping.permissions?.base ?? mapping.mode}`.replace('profile  allows', 'profile allows'));
    if (changes.mode === undefined && !withinMode(mapping.mode, session.mapping.mode)) return refused('permission_escalation', `The change would run the session in ${mapping.mode}, beyond its ${session.mapping.mode}`);
    if (runtimeKind === 'antigravity' && mapping.mode !== session.mapping.mode) return refused('runtime_unsupported', 'Antigravity sessions keep their mode');
    const before = executablesOf(session.mapping);
    const added = [...executablesOf(mapping)].filter(entry => !before.has(entry));
    if (added.length) return refused('permission_escalation', `The change would give the session commands it did not run (${added.map(entry => entry.split(':').slice(0, 2).join(' ')).join(', ')}); start a new session for it`);
    if (proposed.delegates.length && !session.delegation) return refused('invalid_params', 'This session\'s client cannot show assignments, so it cannot take a team that delegates');
    return plan;
  }

  /**
   * Whether the root's native runtime holds a conversation for it (Codex: a turn of its thread; Claude: a
   * transcript entry). Codex's answer for a thread before its first message ("not materialized yet", "no
   * rollout found") means none; any other failure to say is refused, never taken as none, so a held
   * conversation is never left for an empty one.
   */
  async function nativeHistory(session: Session) {
    if (!session.threadId) return false;
    if (session.base) return true;
    const unknown = (error: unknown) => new ConversationError('native_refused', `${label(session.runtimeKind)} could not say whether it holds this session's conversation: ${errorData(error).message}`);
    if (session.runtimeKind === 'codex') {
      try {
        const page = await session.runtime.request('thread/turns/list', { threadId: session.threadId, limit: 1, sortDirection: 'desc' });
        return Array.isArray(page?.data) && page.data.length > 0;
      } catch (error) {
        if (/not materialized|no rollout found/i.test(errorData(error).message)) return false;
        throw unknown(error);
      }
    }
    if (session.runtimeKind === 'claude') {
      try {
        const chain = await session.runtime.request('thread/chain', { threadId: session.threadId, cwd: session.mapping.workdir });
        return Array.isArray(chain?.entries) && chain.entries.length > 0;
      } catch (error) { throw unknown(error); }
    }
    return true;
  }

  /** previewConfigure(): see AlpRuntime.previewConfigure. */
  async function previewConfigureSession(sessionId: string, changes: ConfigureChanges): Promise<ConfigurePreview> {
    const session = sessions.get(sessionId);
    if (!session || session.closed) throw new ConversationError('session_busy', 'The session is not open');
    const plan = await planConfigure(session, changes ?? {});
    const busy = plan.changes.length ? restartRefusal(sessionId, session) : undefined;
    const teams = (await listTeams(session.mapping.agent.projectRoot, { library: options.libraryDir, templates: options.templates }))
      .filter(team => !team.error)
      .map(team => ({ id: team.id, label: team.label ?? team.id, ...(team.description ? { description: team.description } : {}) }));
    return {
      current: plan.current, proposed: plan.proposed, changes: plan.changes,
      restart: plan.changes.some(change => change !== 'mode'),
      allowed: !plan.refusal && !busy,
      ...(plan.refusal ? { reason: plan.refusal.reason as ConfigurePreview['reason'], message: plan.refusal.message } : busy ? { reason: 'session_busy' as const, message: busy } : {}),
      teams,
    };
  }

  /** reconfigure(): see AlpRuntime.reconfigure. */
  async function reconfigureSession(sessionId: string, changes: ConfigureChanges, { fresh = false, onApplied }: { fresh?: boolean; onApplied?: (result: ConfigureResult) => Promise<void> } = {}): Promise<ConfigureResult> {
    // Native apply has already succeeded when this runs. A host persistence failure must not enter
    // the native-refusal rollback path, nor claim that nothing happened.
    async function persist(result: ConfigureResult) {
      try { await onApplied?.(result); }
      catch (error) { throw new ConversationError('native_refused', `The runtime took the configuration but the host could not record it: ${errorData(error).message}`, { outcomeUnknown: true }); }
    }
    const session = sessions.get(sessionId);
    const busy = restartRefusal(sessionId, session);
    if (busy) throw new ConversationError(session && (session.parent || session.role === 'supervisor') ? 'not_root' : 'session_busy', busy);
    const live = session!;
    const plan = await planConfigure(live, changes ?? {});
    if (plan.refusal) throw new ConversationError(plan.refusal.reason, plan.refusal.message);
    // alpd's timeline says the root has no turn yet; the runtime must agree before a new conversation
    // replaces its own (a conversation it holds is resumed, never left behind).
    const starts = fresh && !(plan.changes.length && await nativeHistory(live));
    // Its files were read meanwhile: the tree must still be idle.
    const after = restartRefusal(sessionId, live);
    if (after) throw new ConversationError('session_busy', after);
    if (!plan.changes.length) return { session: snapshot(sessionId, live), effective: plan.current, status: 'unchanged', restarted: false };
    const agent = live.mapping.agent.name;
    if (plan.changes.every(change => change === 'mode')) {
      // Permissions alone change as session.configure { mode } changes them, without a restart.
      await configureSession(sessionId, { mode: plan.shape.mapping.mode }, updated => persist({ session: updated, effective: { ...plan.proposed, instructionsSha: plan.current.instructionsSha }, status: 'applied', restarted: false }));
      runLog(rootOf(sessionId), { event: 'session.configured', sessionId, agent, changes: plan.changes, mode: plan.shape.mapping.mode });
      return { session: snapshot(sessionId, live), effective: { ...plan.proposed, instructionsSha: plan.current.instructionsSha }, status: 'applied', restarted: false };
    }
    if (!starts && !live.threadId) throw new ConversationError('runtime_unsupported', 'This session keeps no native conversation to continue');
    const binding: NativeBinding | undefined = starts ? undefined : { threadId: live.threadId, ...(live.base ? { base: live.base } : {}) };
    const from = { model: live.mapping.model, thinking: live.mapping.thinking, team: live.mapping.workflow.mode, mode: live.mapping.mode };
    const to = { model: plan.shape.mapping.model, thinking: plan.shape.mapping.thinking, team: plan.shape.mapping.workflow.mode, mode: plan.shape.mapping.mode };
    let native: any;
    try {
      native = await restartNative(sessionId, live, binding, true, plan.shape);
      // The runtime's own word on what it took: Codex answers the model it resumed (or started) the thread with.
      if (live.runtimeKind === 'codex' && native?.model !== to.model) throw new ConversationError('native_refused', typeof native?.model === 'string' ? `Codex continued the conversation with ${native.model}, not ${to.model}` : `Codex did not say which model it continued the conversation with, so ${to.model} is not taken`);
    } catch (error) {
      runLog(rootOf(sessionId), { event: 'session.configure_failed', sessionId, agent, from, to, error: errorData(error).message });
      // The session keeps its configuration: a process with it restarts on the same conversation.
      try {
        if (live.closed) throw error;
        await restartNative(sessionId, live, binding, false);
      } catch (reopen) {
        // Neither starts: the session fails as a provider failure does; its record keeps the old configuration.
        live.pending = false;
        if (!live.closed) failSession(sessionId, live, reopen);
      }
      if (error instanceof ConversationError) throw error;
      throw new ConversationError('native_refused', `The runtime did not take the new configuration; the session keeps its own: ${errorData(error).message}`);
    }
    live.mapping = plan.shape.mapping;
    live.graph = plan.shape.graph;
    live.spec = plan.shape.spec;
    // Only Codex answers what it resumed with (its effort applies from the next turn/start); Claude's answer is ALP's own echo.
    const answered = live.runtimeKind === 'codex' ? { ...(typeof native?.model === 'string' ? { model: native.model } : {}), ...(typeof native?.reasoningEffort === 'string' ? { reasoningEffort: native.reasoningEffort } : {}) } : undefined;
    runLog(rootOf(sessionId), { event: 'session.configured', sessionId, agent, changes: plan.changes, from, to, threadId: live.threadId, ...(answered ? { native: answered } : {}) });
    if (plan.changes.includes('team')) {
      // The old team's supervisor ends at this boundary (it reviews nothing: restartRefusal saw to it);
      // the new team's, if it has one, starts beside the root as at open.
      const old = live.supervisor;
      if (old) { live.supervisor = undefined; await closeSession(old).catch(() => {}); }
      if (supervises(live)) void enqueue(() => openSupervisor(sessionId));
    }
    const updated = snapshot(sessionId, live);
    const result: ConfigureResult = {
      session: updated, effective: { ...plan.proposed, ...(live.instructionsSha ? { instructionsSha: live.instructionsSha } : {}) }, status: 'applied', restarted: true,
      ...(answered ? { native: answered } : {}),
    };
    await persist(result);
    emit(sessionId, { type: 'session.updated', session: updated });
    return result;
  }

  /** branch(): makes the native conversation a fork or rewind continues; see AlpRuntime.branch. */
  async function branchConversation(request: BranchRequest): Promise<NativeBinding> {
    if (closed) throw new Error('Runtime is closed');
    if (request.runtime !== 'codex' && request.runtime !== 'claude') throw new ConversationError('runtime_unsupported', `${label(request.runtime)} sessions cannot be forked or rewound`);
    if (!Array.isArray(request.turns) || !request.turns.every(turn => typeof turn === 'string')) throw new Error('branch needs the source turns in order');
    if (typeof request.source?.threadId !== 'string' || !request.source.threadId) throw new Error('branch needs the source thread');
    if (typeof request.model !== 'string' || !request.model || !modes.some(candidate => candidate.id === request.mode)) throw new Error('branch needs the model and mode the branch keeps');
    return request.runtime === 'codex' ? branchCodex(request) : branchClaude(request);
  }

  /**
   * A Codex fork, persisted at once (thread/fork), in a short-lived app-server like recall's. The fork
   * keeps the request's model and settings (Codex otherwise forks with its defaults) and is verified to
   * end at the expected turn; one that does not is deleted. The source thread is never changed.
   */
  async function branchCodex(request: BranchRequest): Promise<NativeBinding> {
    const end = codexForkEnd(request);
    const cwd = request.targetCwd ?? request.cwd;
    const mode = request.mode;
    const transport = createTransport(options, 'codex', cwd, nativeEnvironment(options));
    try {
      try { await transport.initialize(); }
      catch (error) { throw new ConversationError('native_refused', `Codex did not start: ${errorData(error).message}`); }
      let forked: any;
      try {
        forked = await transport.request('thread/fork', {
          threadId: request.source.threadId, ...end.params, ephemeral: false, excludeTurns: true, cwd,
          model: request.model.replace(/^codex:/, ''),
          sandbox: mode === 'full-access' ? 'danger-full-access' : nativeMode({ mode, copy: false }),
          approvalPolicy: codexApproval({ mode, permissions: null }),
        });
      } catch (error) { throw codexForkRefusal(error); }
      const id = forked?.thread?.id;
      // Forked, but under an id ALP cannot read: it may exist, and nothing can be said of it.
      if (typeof id !== 'string' || !id) throw new ConversationError('native_refused', 'Codex answered the fork without a thread id', { outcomeUnknown: true });
      let problem: string | undefined;
      try {
        if (forked.thread.forkedFromId != null && forked.thread.forkedFromId !== request.source.threadId) problem = `it was forked from ${forked.thread.forkedFromId}`;
        else {
          const page = await transport.request('thread/turns/list', { threadId: id, limit: 1, sortDirection: 'desc' });
          const last = page?.data?.[0];
          if (last?.id !== end.last) problem = `it ends at ${last?.id ?? 'no turn'}, not ${end.last}`;
          else if (last.status === 'inProgress') problem = `its last turn ${last.id} is still running`;
        }
      } catch (error) { problem = `it could not be read: ${errorData(error).message}`; }
      if (!problem) return { threadId: id };
      const deleted = await transport.request('thread/delete', { threadId: id }).then(() => true, () => false);
      throw new ConversationError('native_refused', `The Codex fork ${id} could not be verified (${problem}); ${deleted ? 'it was deleted' : 'deleting it failed'}`, { outcomeUnknown: !deleted });
    } finally {
      await transport.close().catch(() => {});
    }
  }

  /**
   * A Claude branch, without touching Claude: the cut is validated against the transcript and returned
   * as a binding whose first prompt makes the fork (resume + forkSession at `at`, under the new id).
   * A source that is itself still a pending fork stands for its base cut at its own `at`.
   */
  async function branchClaude(request: BranchRequest): Promise<NativeBinding> {
    const transport = createTransport(options, 'claude', request.cwd, nativeEnvironment(options));
    try {
      const read = async (threadId: string): Promise<ChainEntry[]> => {
        const answer = await transport.request('thread/chain', { threadId, cwd: request.cwd });
        if (!Array.isArray(answer?.entries)) throw new Error('Claude answered no transcript');
        return answer.entries;
      };
      await transport.initialize();
      let source = request.source.threadId;
      let chain = await read(source);
      if (!chain.length && request.source.base) {
        source = request.source.base.threadId;
        chain = pendingChain(request.source.base, await read(source));
      }
      return { threadId: randomUUID(), base: { threadId: source, at: claudeCut(chain, request) } };
    } catch (error) {
      if (error instanceof ConversationError) throw error;
      throw new ConversationError('native_refused', `The Claude transcript could not be read: ${errorData(error).message}`);
    } finally {
      await transport.close().catch(() => {});
    }
  }

  /** Why recovered sessions were reopened, for what they are told. */
  const restartCause = () => options.previousExit?.kind === 'crash' ? 'alpd stopped unexpectedly' : 'alpd restarted';

  /**
   * Opens an assignment an earlier alpd left running again, under its own id, in
   * its requester's tree: its thread, worktree or copy, write lease, task and claims.
   * Throws, leaving nothing behind but the worktree's branch, when it cannot continue.
   */
  async function resumeAssignment(entry: LiveEntry) {
    const parent = sessions.get(entry.parentId);
    if (!parent || parent.closed) throw new Error('its requester did not come back');
    const id = entry.assignmentId;
    const project = entry.project;
    const assignment: Assignment = {
      id, agent: entry.agent, mode: entry.mode, isolation: entry.isolation, rootId: entry.rootId, startedAt: entry.startedAt, warned: false, finished: false,
      ...(entry.fingerprint ? { fingerprint: entry.fingerprint } : {}),
    };
    let spec = entry.spec;
    // An older alpd may have accepted an effort removed from the catalog since.
    // Migrate only persisted assignments; new explicit requests stay strictly validated.
    if (entry.runtime !== 'acp' && spec.thinking) {
      const available = thinkingOptionsFor(entry.runtime, entry.model);
      if (available.length && !available.some(option => option.id === spec.thinking)) {
        const thinking = models.find(model => model.id === `${entry.runtime}:${entry.model}`)?.defaultThinkingOptionId ?? available[0].id;
        runLog(entry.rootId, { event: 'assignment.thinking_migrated', assignmentId: id, model: entry.model, from: spec.thinking, to: thinking });
        post(entry.parentId, { kind: 'note', from: entry.agent, assignment: id, passive: true, body: `Resuming ${id} with thinking ${thinking}: the current ALP catalog no longer accepts its saved thinking ${spec.thinking} for ${entry.runtime}:${entry.model}.` });
        spec = { ...spec, thinking };
      }
    }
    if (writes(entry.mode)) assignment.writeCheckout = entry.worktree?.checkout ?? await checkoutKey(spec.workdir ?? parent.mapping.workdir);
    const undo = async () => {
      parent.children.delete(id);
      parent.assignments.delete(id);
      childContexts.delete(id);
      if (assignment.lease && leases.get(assignment.lease)?.assignment === id) leases.delete(assignment.lease);
      if (roleOf(parent.mapping, entry.agent) === 'peer') { const root = sessions.get(entry.rootId); if (root) root.peerCount--; }
      if (assignment.copy) await removeCopy(assignment.copy).catch(() => {});
      // The worktree predates this recovery and may hold uncommitted work: it stays (t-eae4).
    };
    try {
      if (entry.lease) {
        const holder = [...leases].find(([key]) => overlapping([entry.lease!], [key]).length)?.[1];
        if (holder && !lineage(entry.parentId).includes(holder.assignment)) throw new Error(`${holder.agent} writes ${entry.lease} now`);
        if (!holder) { assignment.lease = entry.lease; leases.set(entry.lease, { assignment: id, agent: entry.agent }); }
      }
      if (entry.worktree) {
        const { preserved, ...worktree } = await reattachWorktree(entry.worktree);
        assignment.worktree = worktree;
        if (preserved) {
          runLog(entry.rootId, { event: 'worktree.preserved', assignmentId: id, branch: worktree.branch, preserved });
          post(entry.parentId, { kind: 'note', from: entry.agent, assignment: id, passive: true, body: `Reopening ${id}: its worktree ${worktree.path} had no valid git metadata after the restart, so it was moved aside unchanged to ${preserved} and ${worktree.branch} was checked out again. Recover any uncommitted work from ${preserved}.` });
        }
      }
      if (entry.copyOf) {
        assignment.copy = await createCopy(entry.copyOf, copyRoot, id);
        spec = { ...spec, workdir: assignment.copy.workdir };
      }
      parent.children.add(id);
      parent.assignments.set(id, assignment);
      childContexts.set(id, { parent: entry.parentId, callId: entry.callId, graph: parent.graph, workflow: parent.mapping.workflow, ancestry: entry.ancestry, recovered: true });
      if (roleOf(parent.mapping, entry.agent) === 'peer') { const root = sessions.get(entry.rootId); if (root) root.peerCount++; }
      if (entry.taskId) {
        await retakeTask(project, entry.taskId, { assignment: id, pid: process.pid, pidStartedAt: OWN_START, epoch }, 'alpd');
        assignment.taskId = entry.taskId;
        touchTask(entry.rootId, entry.taskId);
      }
      await openSession(id, { ...spec, restore: { agent: entry.agent, threadId: entry.threadId, runtime: entry.runtime, model: entry.model, workflow: parent.mapping.workflow } }, 'skip', entry.delegation, assignment);
      const child = assignmentSessions.get(assignment)!;
      if (sessions.get(id) !== child) throw new Error('Child session was replaced during recovery');
      child.settle = (state, error) => void finishAssignment(entry.parentId, parent, assignment, state, error);
      if (entry.brief) child.brief = entry.brief;
      if (assignment.taskId && writes(entry.mode)) {
        const task = await getTask(project, assignment.taskId).catch(() => undefined);
        if (task?.paths.length) {
          const pins = await boardOf(project);
          if (!claimConflicts(id, pins, task.paths).length) addPin(id, child, pins, { kind: 'claim', body: `Task ${task.id}: ${task.title}`, paths: task.paths, task: task.id });
        }
      }
    } catch (error) {
      await undo();
      throw error;
    }
    void inFlight.put({ ...entry, epoch, spec: { ...spec, thinking: sessions.get(id)!.mapping.thinking } });
    emit(entry.parentId, { type: 'assignment', assignment: assignmentSnapshot(assignment, 'running') });
    return assignment;
  }

  /** An assignment an earlier alpd left running that cannot continue: its task goes back to open, its work stays on its branch. */
  async function abandonEntry(entry: LiveEntry, reason: string) {
    if (entry.worktree || writes(entry.mode)) await assignmentResults.put({
      assignmentId: entry.assignmentId,
      checkout: entry.worktree?.checkout ?? entry.lease ?? entry.spec.writeRoot ?? entry.spec.workdir ?? entry.project,
      ...(entry.worktree ? { worktree: entry.worktree.path } : {}),
    });
    await inFlight.remove(entry.assignmentId);
    const parent = sessions.get(entry.parentId);
    let task: Record<string, unknown> | undefined;
    if (entry.taskId) {
      const released = await releaseTask(entry.project, entry.taskId, { assignment: entry.assignmentId, handoff: null, agent: entry.agent, reason: `${restartCause()} and it could not continue: ${reason}` }, 'alpd').catch(() => undefined);
      if (released) { task = { id: released.id, status: released.status }; touchTask(entry.rootId, released.id); }
    }
    if (entry.worktree) runLog(entry.rootId, { event: 'worktree.kept', assignmentId: entry.assignmentId, branch: entry.worktree.branch });
    const result = {
      agent: entry.agent, sessionId: entry.assignmentId, status: 'failed', handoff: null, output: '',
      error: `${restartCause()} while it worked, and it could not continue: ${reason}`,
      ...(entry.worktree ? { worktree: { branch: entry.worktree.branch, kept: true } } : {}), ...(task ? { task } : {}),
    };
    runLog(entry.rootId, { event: 'assignment.finished', assignmentId: entry.assignmentId, reconciled: true, ...result });
    if (parent && !parent.closed) post(entry.parentId, { kind: 'result', from: entry.agent, assignment: entry.assignmentId, result });
  }

  /**
   * Continues what an earlier alpd left running in an open root's tree, nearest the
   * root first, since each assignment needs its requester open. Each one continues
   * its turn, or waits parked when its runtime is paused or the user resumes recovery.
   */
  async function recoverTree(rootId: string, continueRoot: boolean, parkedRoot?: string): Promise<RecoveryOutcome[]> {
    const root = sessions.get(rootId);
    if (!root || root.closed) throw new Error(`Session ${rootId} is not open`);
    const entries = inherited.filter(entry => entry.rootId === rootId).sort((a, b) => a.ancestry.length - b.ancestry.length);
    inherited = inherited.filter(entry => entry.rootId !== rootId);
    const outcomes: RecoveryOutcome[] = [];
    const resumed = new Map<string, Assignment[]>();
    for (const entry of entries) {
      try {
        const assignment = await resumeAssignment(entry);
        resumed.set(entry.parentId, [...(resumed.get(entry.parentId) ?? []), assignment]);
        outcomes.push({ assignmentId: entry.assignmentId, agent: entry.agent, outcome: 'resumed' });
      } catch (error) {
        const message = errorData(error).message;
        await abandonEntry(entry, message);
        outcomes.push({ assignmentId: entry.assignmentId, agent: entry.agent, outcome: 'failed', error: message });
      }
    }
    const cause = restartCause();
    const listed = (assignments: Assignment[] = []) => assignments.length
      ? ` These assignments of yours continue and report to you: ${assignments.map(assignment => `${assignment.id} (${assignment.agent}${assignment.taskId ? `, task ${assignment.taskId}` : ''})`).join(', ')}. Wait for them with alp_wait, or keep working.`
      : '';
    const proceed = (sessionId: string, session: Session, text: string) => {
      if (options.recoveryResume === false || pauseOf(session.runtimeKind)) {
        session.parked = { reason: cause, since: Date.now(), prompt: text, ...(options.recoveryResume !== false ? { pause: { scope: paused.all ? 'all' as const : session.runtimeKind } } : {}) };
        emit(sessionId, { type: 'session.updated', session: snapshot(sessionId, session) });
        runLog(rootId, { event: 'assignment.parked', assignmentId: sessionId, agent: session.mapping.agent.name, reason: cause });
        const outcome = outcomes.find(entry => entry.assignmentId === sessionId);
        if (outcome) outcome.outcome = 'parked';
        return;
      }
      void startPrompt(sessionId, { clientMessageId: `alp-recover-${randomUUID()}`, delivery: 'auto', content: [{ type: 'text', text }] }, session.parent ? 'assignment' : 'wake')
        .catch(error => session.settle?.('failed', error));
    };
    for (const entry of entries) {
      const child = sessions.get(entry.assignmentId);
      if (!child || child.closed || !outcomes.some(outcome => outcome.assignmentId === entry.assignmentId && outcome.outcome === 'resumed')) continue;
      runLog(rootId, { event: 'assignment.recovered', assignmentId: entry.assignmentId, agent: entry.agent, ...(entry.taskId ? { taskId: entry.taskId } : {}) });
      proceed(entry.assignmentId, child, `ALP: ${cause} while you worked on this assignment, and reopened this session. Your earlier work in it${entry.worktree ? ' and your worktree' : ''} is intact; check where you stopped (for example with git status), then continue. Finish with alp_handoff as before.${listed(resumed.get(entry.assignmentId))}`);
    }
    if (parkedRoot) {
      root.parked = { reason: parkedRoot, since: Date.now() };
      emit(rootId, { type: 'session.updated', session: snapshot(rootId, root) });
      // Legacy persisted reasons carry no pause provenance. Only an explicit session prompt
      // can release them, including old quota/process parks; never infer scope from text or flags.
    } else if (continueRoot) proceed(rootId, root, `ALP: ${cause} during your turn, and reopened this session. Continue the user's request where you stopped.${listed(resumed.get(rootId))}`);
    else for (const assignment of resumed.get(rootId) ?? []) post(rootId, { kind: 'note', from: assignment.agent, assignment: assignment.id, passive: true, body: `${cause}; ALP reopened this assignment and it continues. It reports when done.` });
    const failed = outcomes.filter(outcome => outcome.outcome === 'failed');
    if (entries.length || continueRoot || parkedRoot) {
      const parked = outcomes.flatMap(outcome => {
        const park = outcome.outcome === 'parked' ? sessions.get(outcome.assignmentId)?.parked : undefined;
        return park ? [park] : [];
      });
      if ((continueRoot || parkedRoot) && root.parked) parked.push(root.parked);
      const next = parked.some(park => !park.pause)
        ? 'send an explicit prompt to each parked session to continue it: alp send <session> --prompt <text>'
        : 'run alp resume to continue them';
      notice(failed.length ? 'warning' : 'info',
        `ALP: ${cause}${options.previousExit?.at ? ` (around ${options.previousExit.at})` : ''}. ` +
        `${entries.length - failed.length} of ${entries.length} running assignments reopened${continueRoot || parkedRoot ? ', and this session' : ''}` +
        `${parked.length ? `; they wait parked: ${next}` : ''}.` +
        `${failed.length ? ` Could not continue: ${failed.map(outcome => `${outcome.agent} ${outcome.assignmentId} (${outcome.error})`).join('; ')}; their tasks went back to open.` : ''}`,
        root.mapping.agent.projectRoot);
    }
    return outcomes;
  }

  function openOf(sessionId: string) {
    const session =
      sessions.get(sessionId);

    if (
      !session ||
      session.closed
    ) {
      throw new Error(
        'Session is not open',
      );
    }
    return session;
  }

  async function configureSession(sessionId: string, changes: { mode?: string }, beforeUpdated?: (session: SessionSnapshot) => Promise<void>) {
    const session = openOf(sessionId);
    if (session.active || session.pending || session.children.size) throw new Error('Wait for the current turn and child sessions to finish before changing permissions');
    const mode = changes.mode ?? session.mapping.mode;
    if (!modes.some(candidate => candidate.id === mode)) throw new Error(`Unsupported mode '${mode}'`);
    const profile = session.mapping.permissions;
    if (profile && !withinMode(mode, profile.base)) {
      throw new Error(READ_ONLY_AGENTS.includes(session.mapping.agent.name) ? 'Advisors and the supervisor must remain read-only' : `Permission profile ${profile.name} allows at most ${profile.base}`);
    }
    const parent = session.parent ? sessions.get(session.parent) : undefined;
    if (parent && !withinMode(mode, parent.mapping.mode)) throw new Error('Child cannot exceed parent permissions');
    if (session.runtimeKind === 'antigravity' && mode !== session.mapping.mode) throw new Error('Antigravity uses full-access natively; its permission instructions are fixed for the session. Open a new session to change mode');
    if (session.runtimeKind === 'claude') await session.runtime.request('session/configure', { sandbox: nativeMode({ mode, copy: session.mapping.copy }) });
    session.mapping.mode = mode;
    session.spec = { ...session.spec, mode };
    const updated = snapshot(sessionId, session);
    if (beforeUpdated) await beforeUpdated(updated);
    emit(sessionId, { type: 'session.updated', session: updated });
    return updated;
  }

  /** Codex threads whose last turn the user stopped: what it had written, for the next prompt. */
  const interruptedThreads = new Map<string, string>();

  async function interruptSession(sessionId: string) {
    const session = openOf(sessionId);
    const activeTurn =
      session.active;

    session.wakeBlocked = true;
    session.userStopped = true;
    session.parked = undefined;
    session.parkReason = undefined;
    session.parkPause = undefined;
    session.resumeHeld = undefined;
    emit(sessionId, { type: 'session.updated', session: snapshot(sessionId, session) });
    approvalCancellation.set(session, (approvalCancellation.get(session) ?? 0) + 1);
    cancelQuestions(sessionId);
    // Codex keeps no output of an interrupted turn in its thread: remember what the user saw, by
    // thread, since a client that leaves closes the session and the next prompt opens it again.
    if (activeTurn && session.runtimeKind === 'codex' && session.threadId) {
      const partial = [...session.text.values()].join('\n').trim();
      if (partial) interruptedThreads.set(session.threadId, partial.slice(-4000));
    }

    terminal(
      sessionId,
      session,
      'canceled',
    );

    await Promise.all(
      [...session.children].map(
        id => closeSession(id),
      ),
    );

    // An idle requester waiting on its assignments has no turn to cancel; end its assignment now.
    if (!activeTurn) session.settle?.('canceled', 'Interrupted');

    if (activeTurn) {
      await session.runtime.request(
        'turn/interrupt',
        {
          threadId:
            session.threadId,
          turnId: activeTurn,
        },
      );
    }
  }

  // Shared by ordinary prompts and the scheduler's queue-scoped sender.
  async function promptSession(sessionId: string, input: PromptInput, flushing = false): Promise<void> {
    const session = sessions.get(sessionId);
    // While main writes its checkpoint and compacts, the user's words wait for the compaction's end (t-0e56).
    if (!flushing && session && !session.parent && (session.compacting || session.compactBuffer?.length)) {
      if (!session.seen.has(input.clientMessageId) && !session.compactBuffer?.some(held => held.clientMessageId === input.clientMessageId)) (session.compactBuffer ??= []).push(input);
      return;
    }
    const parked = session?.parked;
    try {
      const prompt = session?.active && session.resumedTurn === session.active && input.delivery === 'auto'
        ? { ...input, delivery: 'steer' as const } : input;
      await startPrompt(sessionId, prompt, 'user');
      if (session && parked && session.parked === parked) {
        session.parked = undefined;
        emit(sessionId, { type: 'session.updated', session: snapshot(sessionId, session) });
      }
    } catch (error) {
      const session = sessions.get(sessionId);
      if (session?.seen.has(input.clientMessageId)) return;
      session?.seen.add(input.clientMessageId);
      emit(sessionId, { type: 'prompt.failed', clientMessageId: input.clientMessageId, error: errorData(error) });
    }
  }

  /** Starts a turn or steers the running one; throws when the prompt was not delivered. */
  async function startPrompt(sessionId: string, prompt: PromptInput, origin: TurnOrigin, wake?: MailEvent[]) {
    const session = openOf(sessionId);

    if (
      session.seen.has(
        prompt.clientMessageId,
      )
    ) {
      return;
    }

    if (prompt.content.some(content => content.type !== 'text' && content.type !== 'image' && content.type !== 'attachment')) {
      throw new Error('Only text, image and attachment prompts are supported');
    }
    // Inline images only, never a path or URL: the native input gets a data URL ALP builds itself.
    const images = prompt.content.filter(content => content.type === 'image') as Array<{ type: 'image'; mimeType: string; data: string }>;
    if (images.length) {
      if (!takesImages(session)) throw new Error(`${session.runtimeKind === 'acp' ? 'This ACP agent' : session.runtimeKind[0].toUpperCase() + session.runtimeKind.slice(1)} takes no images; send the message as text`);
      if (images.length > PROMPT_IMAGES.maxCount) throw new Error(`A prompt takes at most ${PROMPT_IMAGES.maxCount} images`);
      if (images.reduce((sum, image) => sum + (typeof image.data === 'string' ? base64Bytes(image.data) : 0), 0) > PROMPT_IMAGES.maxTotalBytes) throw new Error(`The images of a prompt are at most ${PROMPT_IMAGES.maxTotalBytes} bytes together`);
      for (const image of images) {
        const keys = Object.keys(image).filter(key => !['type', 'mimeType', 'data', 'name'].includes(key));
        if (keys.length || !PROMPT_IMAGES.mimeTypes.includes(image.mimeType) || typeof image.data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data) || base64Bytes(image.data) > PROMPT_IMAGES.maxBytes) {
          throw new Error(`An image must be inline base64 ${PROMPT_IMAGES.mimeTypes.join(', ')} of at most ${PROMPT_IMAGES.maxBytes} bytes`);
        }
      }
    }

    // Attachments (§12.6): descriptors alpd resolved and pinned for this session, never a path. Each
    // gets a read-only copy staged from alpd's verified bytes before the turn names it.
    const attached: Array<{ attachment: RuntimeAttachment; staged: string }> = [];
    const attachmentParts = prompt.content.filter(content => content.type === 'attachment');
    if (attachmentParts.length) {
      if (!attachmentRoutes(session).includes('file.path') || !stager || !attachmentReader) {
        throw new Error(`${session.runtimeKind === 'acp' ? 'This ACP agent' : session.runtimeKind[0].toUpperCase() + session.runtimeKind.slice(1)} cannot read attached files; they stay stored and the message was not sent`);
      }
      // Told once per session, when it first stages, never at alpd's start (its log stays quiet until there is something to say).
      if (!stagingWarned.has(sessionId)) {
        stagingWarned.add(sessionId);
        const exposed = stagingExposure(stager.root, [session.mapping.workdir, os.tmpdir(), '/tmp']);
        if (exposed) log.warn(`the attachment staging directory is inside ${exposed === session.mapping.workdir ? 'this session\'s workspace' : 'the temp directory'}, which sandboxed sessions may write: a tool could change a staged copy before it is read; keep ALP_HOME outside both (default ~/.alp)`, { code: 'ALP_ATTACHMENT_STAGE_EXPOSED', sessionId });
      }
      for (const part of attachmentParts) {
        const attachment = runtimeAttachment(part);
        if (!attachment) throw new Error('An attachment in a prompt must be one alpd resolved');
        attached.push({ attachment, staged: await stager.stage(attachmentReader, attachment, sessionId) });
      }
    }

    if (
      prompt.delivery === 'steer' &&
      !session.active
    ) {
      throw new Error(
        'No active turn to steer',
      );
    }

    if (
      prompt.delivery !== 'steer' &&
      session.active
    ) {
      throw new Error(
        'Turn already active; use steering or interrupt first',
      );
    }

    const text = prompt.content
      .filter(content => content.type === 'text')
      .map(content => content.text ?? '')
      .join('\n');

    // Steering changes the brief; live assignments keep running and report by mail.
    const mail = wake ?? (prompt.delivery === 'steer' ? [] : takeBatch(session.mail, () => true));
    for (const event of mail) event.deliveredTurn = STARTING;

    session.pending = true;

    let acknowledged!: () => void;

    session.acknowledged =
      new Promise((resolve) => {
        acknowledged = resolve;
      });

    if (
      prompt.delivery !== 'steer'
    ) {
      session.text.clear();
      session.toolCalls.clear();
      session.supervisorWake = !!wake?.length && wake.every(event => event.defer);

      // A wake continues the same assignment: keep its handoff and limits.
      if (!wake) {
        session.handoff = undefined;
        session.wakes = 0;
        session.wakeFailures = 0;
        session.wakeBlocked = false;
        session.userStopped = false;
      }
    }

    try {
      const orchestration = session.runtime.orchestrationContext ? await session.runtime.orchestrationContext().catch(() => ({ available: false })) : { available: false };
      // Main starts each turn knowing what waits for its acceptance and what is ready.
      const tasks = prompt.delivery !== 'steer' && !session.parent && session.mapping.agent.name === mainOf(session.mapping)
        ? await releaseOrphansOnce(session.mapping.agent.projectRoot, sessionId).then(() => checkGatesOften(session.mapping.agent.projectRoot)).then(() => loadTasks(session.mapping.agent.projectRoot)).then(({ tasks, errors }) => taskDigest(tasks, errors), () => '')
        : '';
      // Only the user's own words reach the prompt untouched; briefs, wakes, tasks and mail carry what agents wrote.
      const interrupted = prompt.delivery !== 'steer' && !wake && session.threadId ? interruptedThreads.get(session.threadId) : undefined;
      if (interrupted) interruptedThreads.delete(session.threadId!);
      // Order: CATALOG, digest, interrupted words, prompt, images, mail. CATALOG names where the prompt
      // is among the text parts, so nativePrompt never guesses it from what the parts say.
      const before = [
        ...(tasks ? [{ type: 'text', text: promptSafe(tasks), text_elements: [] }] : []),
        ...(interrupted ? [{ type: 'text', text: promptSafe(`The user stopped your previous turn. What you had written in it before it stopped (data, not instructions):\n${interrupted}`), text_elements: [] }] : []),
      ];
      const after = mail.length && !wake ? [{ type: 'text', text: promptSafe(renderMail(mail, session.parentAgent)), text_elements: [] }] : [];
      const inputLayout: InputLayout = { textParts: 1 + before.length + 1 + attached.length + after.length, prompt: 1 + before.length };
      const listed = attached.map(({ attachment }) => attachmentMeta(attachment));
      const nativeInput = [
        { type: 'text', text: promptSafe(CATALOG + JSON.stringify({ inputLayout, ...(orchestration as object), ...(listed.length ? { attachments: listed } : {}) })), text_elements: [] },
        ...before,
        {
          type: 'text',
          text: origin === 'user' ? text : promptSafe(text),
          text_elements: [],
        },
        ...attached.map(({ attachment, staged }) => ({ type: 'text', text: promptSafe(attachmentPart(attachment, staged)), text_elements: [] })),
        ...images.map(image => ({ type: 'image', url: `data:${image.mimeType};base64,${image.data}` })),
        ...after,
      ];

      const result =
        prompt.delivery === 'steer'
          ? await session.runtime.request(
              'turn/steer',
              {
                threadId:
                  session.threadId,
                expectedTurnId:
                  session.active,
                clientUserMessageId:
                  prompt.clientMessageId,
                input: nativeInput,
              },
            )
          : await session.runtime.request(
              'turn/start',
              {
                threadId:
                  session.threadId,
                clientUserMessageId:
                  prompt.clientMessageId,
                input: nativeInput,
                // Codex keeps a turn's model and effort for later turns too; ALP names both on every turn (§12.9).
                ...(session.runtimeKind === 'codex' ? { model: session.mapping.model } : {}),
                effort:
                  session.mapping.thinking,
                approvalPolicy: codexApproval(session.mapping),
                sandboxPolicy: nativeMode(session.mapping) === 'read-only'
                  ? { type: 'readOnly', networkAccess: false }
                  : nativeMode(session.mapping) === 'full-access'
                    ? { type: 'dangerFullAccess' }
                    : { type: 'workspaceWrite', writableRoots: [session.mapping.workdir], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
              },
            );

      const turnId =
        prompt.delivery === 'steer'
          ? session.active!
          : result.turn.id;

      for (const event of mail) event.deliveredTurn = turnId;

      // Only transport-accepted user input renews the root-tree budgets.
      if (!session.parent && origin === 'user') {
        session.calls = 0;
        session.advisorCalls = 0;
      }

      session.seen.add(
        prompt.clientMessageId,
      );

      emit(sessionId, {
        type: 'item',
        item: {
          kind: 'user_message',
          id: `user:${prompt.clientMessageId}`,
          clientMessageId: prompt.clientMessageId,
          text,
          origin,
          ...(images.length ? { images: images.length } : {}),
          ...(listed.length ? { attachments: listed } : {}),
        },
      });
      if (origin === 'user' && !session.parent) session.userWaiting ??= Date.now();
      if (origin === 'user' && !session.parent && text) session.lastUserText = clip(text, 4000);
      if (session.supervisor && origin === 'user') session.journal.push(stamp(`user ${prompt.delivery === 'steer' ? 'steered' : 'asked'} ${session.mapping.agent.name}: ${clip(text, 1500)}`));
      // The steer reaches the model once its waiting tool returns; return it now, not when the work ends.
      if (prompt.delivery === 'steer' && origin === 'user' && !session.parent) { releaseWaiters(session); releaseQuestions(sessionId); }

      emit(sessionId, {
        type: 'prompt.accepted',
        clientMessageId: prompt.clientMessageId,
        result: prompt.delivery === 'steer' ? 'steer' : 'turn',
        turnId,
      });

      if (
        prompt.delivery !== 'steer'
      ) {
        session.active = turnId;
        emit(sessionId, { type: 'turn.started', turnId, origin });
      }
    } finally {
      // A turn that never started did not receive its mail.
      for (const event of mail) if (event.deliveredTurn === STARTING) event.deliveredTurn = undefined;

      session.pending = false;
      acknowledged();

      for (
        const [method, params] of
        session.buffered.splice(0)
      ) {
        notification(
          sessionId,
          session,
          method,
          params,
        );
      }

      // Mail beyond the first batch follows into the running turn.
      if (hasActiveMail(session)) deliver(sessionId, session);
    }
  }

  // Threads past their recall time go when the host starts, and after each assignment.
  if (options.recallFile) void forgetExpired();

  return {
    registerWorkspace: directory => enqueue(async () => {
      try { await assignmentResults.register(await realpath(directory)); }
      catch (error) { refuseMutation('workspace_assignment_result', error instanceof Error ? error.message : 'Cannot register workspace result ownership'); }
    }),
    withWorkspaceMutation: <T>(directory: string, run: () => Promise<T>): Promise<T> => {
      // Reserve before enqueue/await: in-flight admission causes refusal, future admission cannot start.
      if (workspaceMutation || admitting) return Promise.reject(new WorkspaceMutationError('workspace_busy', 'A session or assignment is opening; retry after it finishes'));
      workspaceMutation = true;
      return enqueue(async () => {
          const target = await realpath(directory).catch(() => refuseMutation('workspace_busy', `Cannot resolve workspace ${directory}; inspect its directory before removing it`));
          let resultLedger: Awaited<ReturnType<typeof assignmentResults.inspect>>;
          try { resultLedger = await assignmentResults.inspect(); }
          catch (error) { refuseMutation('workspace_assignment_result', error instanceof Error ? error.message : 'Cannot inspect permanent assignment results'); }
          if (!resultLedger!.workspaces.includes(target)) refuseMutation('workspace_assignment_result', 'Workspace predates authoritative assignment tracking; an audited migration is required before removal');
          const canonical = (value: string): string => {
            try { return realpathSync(value); }
            catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') refuseMutation('workspace_assignment_result', `Cannot resolve assignment path ${value}; inspect it before removing the workspace`);
              const parent = path.dirname(value);
              if (parent === value) throw error;
              return path.join(canonical(parent), path.basename(value));
            }
          };
          const overlaps = (value: string | undefined) => {
            if (value === undefined) return false;
            if (typeof value !== 'string' || !value) refuseMutation('workspace_assignment_result', 'Invalid assignment path; repair runtime persistence before removing the workspace');
            if (!path.isAbsolute(value)) refuseMutation('workspace_assignment_result', 'Assignment path is not absolute; inspect runtime persistence before removing the workspace');
            const owner = canonical(value);
            const contains = (parent: string, child: string) => {
              const relative = path.relative(parent, child);
              return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
            };
            return contains(target, owner) || contains(owner, target);
          };
          for (const entry of resultLedger!.results) if (overlaps(entry.checkout) || overlaps(entry.worktree)) refuseMutation('workspace_assignment_result', `Resolve permanent assignment result ${entry.assignmentId} before removing ${directory}`);
          for (const [project, pins] of loadedBoards) for (const pin of pins) {
            if (pin.kind === 'claim' && live(pin) && pin.paths?.some(value => overlaps(path.resolve(project, value)))) refuseMutation('workspace_claimed', `Release claim ${pin.id} before removing ${directory}`);
          }
          for (const [checkout, holder] of leases) if (overlaps(checkout)) refuseMutation('workspace_leased', `Assignment ${holder.assignment} holds a write lease in ${directory}`);
          for (const [id, session] of sessions) {
            for (const assignment of session.assignments.values()) {
              if (overlaps(assignment.worktree?.path) || overlaps(assignment.worktree?.checkout) || overlaps(assignment.copy?.path) || overlaps(assignment.copy?.checkout) || overlaps(assignment.writeCheckout) || overlaps(assignment.lease)) refuseMutation('workspace_assignment_result', `Resolve assignment ${assignment.id} before removing ${directory}`);
            }
            for (const [assignmentId, pending] of session.worktrees) if (overlaps(pending.worktree.path) || overlaps(pending.worktree.checkout) || overlaps(pending.worktree.workdir)) refuseMutation('workspace_assignment_result', `Merge or preserve assignment ${assignmentId} before removing ${directory}`);
            if (!session.closed && (overlaps(session.mapping.workdir) || overlaps(session.spec.writeRoot))) refuseMutation('workspace_busy', `Close session ${id} before removing ${directory}`);
          }
          const checkLive = (entry: LiveEntry) => {
            if (overlaps(entry.spec.workdir ?? entry.project) || overlaps(entry.spec.writeRoot) || overlaps(entry.copyOf) || overlaps(entry.lease) || overlaps(entry.worktree?.path) || overlaps(entry.worktree?.checkout) || overlaps(entry.worktree?.workdir)) refuseMutation('workspace_assignment_result', `Resolve recoverable assignment ${entry.assignmentId} before removing ${directory}`);
          };
          for (const entry of inFlight.all()) checkLive(entry);
          for (const entry of inherited) checkLive(entry);
          // Read disk strictly: the normal books intentionally tolerate damaged records.
          for (const [file, kind] of [[options.liveFile, 'live'], [options.recallFile, 'recall']] as const) {
            if (!file) continue;
            let entries: unknown;
            try { entries = JSON.parse(await readFile(file, 'utf8')); }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw new WorkspaceMutationError('workspace_assignment_result', `Cannot inspect ${file}; repair assignment persistence before removing the workspace`); }
            if (!Array.isArray(entries)) refuseMutation('workspace_assignment_result', `Invalid assignment book ${file}`);
            for (const entry of entries as any[]) {
              if (!entry || typeof entry.assignmentId !== 'string' || (kind === 'live' ? !entry.spec || typeof entry.spec !== 'object' || Array.isArray(entry.spec) || typeof entry.project !== 'string' : typeof entry.cwd !== 'string')) refuseMutation('workspace_assignment_result', `Invalid assignment record in ${file}`);
              if (entry.worktree !== undefined && (!entry.worktree || !['path', 'checkout', 'workdir'].every(key => typeof entry.worktree[key] === 'string'))) refuseMutation('workspace_assignment_result', `Invalid worktree result in ${file}`);
              if (entry.shared !== undefined && (!entry.shared || typeof entry.shared !== 'object' || Array.isArray(entry.shared))) refuseMutation('workspace_assignment_result', `Invalid shared result in ${file}`);
              if (kind === 'live') checkLive(entry);
              else if (overlaps(entry.cwd) || overlaps(entry.shared?.writeRoot)) refuseMutation('workspace_assignment_result', `Preserve retained assignment ${entry.assignmentId} before removing ${directory}`);
            }
          }
          for (const entry of await recalls.all()) if (overlaps(entry.cwd) || overlaps(entry.shared?.writeRoot)) refuseMutation('workspace_assignment_result', `Preserve retained assignment ${entry.assignmentId} before removing ${directory}`);
          return await run();
      }).finally(() => { workspaceMutation = false; });
    },
    bindSchedules(handler: ScheduleHandler | undefined) { scheduleHandler = handler; },
    bindAttachments(reader: AttachmentReader | undefined) { attachmentReader = reader; },
    takesAttachments(sessionId: string) {
      const session = sessions.get(sessionId);
      return !!session && !session.closed && attachmentRoutes(session).includes('file.path');
    },
    async dropAttachment(attachmentId: string) { await stager?.drop(attachmentId); },
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    open: (sessionId, spec, { history = 'skip', delegation = true } = {}) => enqueue(async () => {
      const opened = await openSession(sessionId, spec, history, delegation);
      const root = sessions.get(sessionId)!;
      // Main starts its supervisor beside it, without delaying its own open.
      if (supervises(root)) void enqueue(() => openSupervisor(sessionId));
      return opened;
    }),

    prompt: (sessionId, input) => enqueue(() => promptSession(sessionId, input)),

    withIdlePrompt: (sessionId, run) => new Promise((resolve, reject) => {
      void enqueue(async () => {
        const session = openOf(sessionId);
        if (session.active || session.pending || session.lifecycleHolds || session.mail.some(event => event.deliveredTurn === STARTING)) { resolve({ busy: true }); return; }
        // Expose the reservation to lifecycle operations before any durable write can yield.
        admittedPrompts.add(sessionId);
        // Keep newly arriving mail unreserved until this admitted prompt has finished preparation.
        session.lifecycleHolds = (session.lifecycleHolds ?? 0) + 1;
        let valid = true;
        let used = false;
        let sending: Promise<void> | undefined;
        try {
          const value = await run(input => {
            if (!valid || used) return Promise.reject(new Error('The admitted prompt sender is no longer available'));
            used = true;
            sending = promptSession(sessionId, input);
            return sending;
          });
          resolve({ busy: false, value });
        } catch (error) {
          reject(error);
        } finally {
          valid = false;
          // A timeout of the caller cannot release the queue while its native start is outstanding.
          try { await sending; }
          finally {
            admittedPrompts.delete(sessionId);
            session.lifecycleHolds = Math.max(0, (session.lifecycleHolds ?? 1) - 1);
            if (!session.lifecycleHolds && !session.closed && session.wakeHeld) {
              session.wakeHeld = false;
              deliver(sessionId, session);
            }
          }
        }
      }).catch(reject);
    }),

    interrupt: sessionId => enqueue(() => interruptSession(sessionId)),
    interruptTurn: (sessionId, turnId) => enqueue(async () => {
      // Compare in the same admission slot as the cancellation, before any side effect or await.
      if (sessions.get(sessionId)?.active !== turnId) return false;
      await interruptSession(sessionId);
      return true;
    }),

    configure: (sessionId, changes, options) => enqueue(() => configureSession(sessionId, changes, options?.onApplied)),

    branch: request => branchConversation(request),

    rebind: (sessionId, binding) => enqueue(() => rebindSession(sessionId, binding)),

    reload: sessionId => enqueue(() => reloadSession(sessionId)),
    compact: (sessionId: string) => requestCompact(sessionId),

    previewConfigure: (sessionId, changes) => previewConfigureSession(sessionId, changes),

    reconfigure: (sessionId, changes, options) => enqueue(() => reconfigureSession(sessionId, changes, options)),

    starting: sessionId => {
      const session = sessions.get(sessionId);
      return !!session && !session.closed && (admittedPrompts.has(sessionId) || !!session.pending || session.mail.some(event => event.deliveredTurn === STARTING));
    },

    hold: sessionId => {
      const session = sessions.get(sessionId);
      if (!session || session.closed) return undefined;
      session.lifecycleHolds = (session.lifecycleHolds ?? 0) + 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        session.lifecycleHolds = Math.max(0, (session.lifecycleHolds ?? 1) - 1);
        if (session.lifecycleHolds || session.closed) return;
        // Parked work a resume reached during the hold continues now; paused again, it waits for that resume.
        if (session.resumeHeld) {
          const expected = session.resumeHeld;
          session.resumeHeld = undefined;
          if (session.parked === expected) return continueParked(sessionId, session, expected);
        }
        if (session.parked || pauseOf(session.runtimeKind) || !session.wakeHeld) return;
        session.wakeHeld = false;
        deliver(sessionId, session);
      };
    },

    close: sessionId => enqueue(async () => {
      openOf(sessionId);
      await closeSession(sessionId);
    }),

    snapshot(sessionId) {
      const session = sessions.get(sessionId);
      return session && !session.closed ? snapshot(sessionId, session) : undefined;
    },

    status(sessionId) {
      const rootId = rootOf(sessionId);
      const root = sessions.get(rootId);
      if (!root || root.closed) return undefined;
      const now = Date.now();
      const tree: Array<[string, Session]> = [];
      const visit = (id: string) => {
        const session = sessions.get(id);
        if (!session || session.closed) return;
        tree.push([id, session]);
        for (const child of session.children) visit(child);
        if (session.supervisor) visit(session.supervisor);
      };
      visit(rootId);
      const questions = [...userQuestions.values()].map(pending => pending.question).filter(question => question.rootId === rootId);
      const asking = new Set(questions.filter(question => !question.gate).map(question => question.sessionId));
      const ids = new Set(tree.map(([id]) => id));
      return {
        rootId,
        sessions: tree.map(([id, session]) => {
          const parent = session.parent ? sessions.get(session.parent) : undefined;
          const waitingParent = !!parent?.assignments.get(id)?.ask && !asking.has(id);
          const snap = snapshot(id, session);
          return {
            ...snap,
            state: asking.has(id) ? 'waiting_user' as const : waitingParent ? 'waiting_parent' as const : session.active ? 'running' as const : snap.busy ? 'waiting' as const : 'idle' as const,
            idleMs: now - session.lastActivity,
            workdir: session.mapping.workdir,
            unreadMail: session.mail.filter(event => !event.deliveredTurn && !event.passive).length,
          };
        }),
        assignments: tree.flatMap(([id, session]) => [...session.assignments.values()].map(assignment => ({
          ...assignmentSnapshot(assignment, asking.has(assignment.id) ? 'waiting_user' : assignment.ask ? 'waiting_parent' : 'running'),
          requester: id,
          isolation: assignment.isolation,
          idleMs: now - (sessions.get(assignment.id)?.lastActivity ?? assignment.startedAt),
        }))),
        questions,
        worktrees: tree.flatMap(([id, session]) => [...session.worktrees].map(([assignmentId, pending]) => ({
          assignmentId, requester: id, agent: pending.agent, branch: pending.worktree.branch, files: pending.change.files, stat: pending.change.stat,
        }))),
        leases: [...leases].filter(([, holder]) => ids.has(holder.assignment)).map(([checkout, holder]) => ({ checkout, assignmentId: holder.assignment, agent: holder.agent })),
        claims: (loadedBoards.get(root.mapping.agent.projectRoot) ?? []).filter(pin => pin.kind === 'claim' && live(pin) && ids.has(pin.sessionId)),
      };
    },

    pause(input = {}) {
      const { runtime, now = false, reason } = input;
      if (runtime !== undefined && !RUNTIMES.includes(runtime)) throw new Error('runtime must be codex or claude');
      if (reason !== undefined && (typeof reason !== 'string' || reason.length > 500)) throw new Error('reason must be text of at most 500 characters');
      const pause: Pause = { since: new Date().toISOString(), by: 'the user', reason: reason?.trim() || 'paused by the user' };
      pauseRuntime(runtime ?? 'all', pause, now);
      notice('warning', say => say.paused(runtime ? label(runtime) : 'ALP', reason?.trim() || undefined, runtime && label(runtime), Boolean(now)));
      return pauseState();
    },

    resume(input = {}) {
      const { runtime } = input;
      if (runtime !== undefined && !RUNTIMES.includes(runtime)) throw new Error('runtime must be codex or claude');
      if (runtime && paused.all) throw new Error('All of ALP is paused; alp resume without a runtime lifts it');
      resumeRuntime(runtime ?? 'all', 'the user');
      return pauseState();
    },

    pauses: () => pauseState(),
    async usage(refresh = false) {
      const providers = await Promise.all((['codex', 'claude'] as const).map(kind => cachedUsage(kind, refresh)));
      const state = pauseState();
      return { providers: providers.map(provider => ({ ...provider, pause: state.all ?? state.runtimes[provider.runtime] ?? null, parked: state.parked.filter(entry => entry.runtime === provider.runtime).length })) };
    },

    async recall(target, question) {
      if (typeof question !== 'string' || !question.trim() || question.length > RECALL_QUESTION_CHARS) throw new Error(`The question must be text of at most ${RECALL_QUESTION_CHARS} characters`);
      if (!target || (typeof target.assignmentId === 'string') === (typeof target.taskId === 'string')) throw new Error('Name either an assignment or a task');
      if (target.assignmentId && sessions.has(target.assignmentId)) throw new Error('That assignment is still running; write to it with alp send');
      const entry = await findRecall(target);
      if (!entry) throw new Error(`${target.taskId ? `No recallable assignment worked on ${target.taskId}` : `No recallable assignment ${target.assignmentId}`}; assignments stay recallable for ${RECALL_KEEP_MS / 86_400_000} days`);
      const answer = await askRecalled(entry, 'The user', question);
      runLog(entry.rootId, { event: 'recall', agent: 'user', assignmentId: entry.assignmentId, recalled: entry.agent, question: clip(question, 500), answer: clip(answer, 500) });
      return { assignmentId: entry.assignmentId, agent: entry.agent, ...(entry.taskId ? { taskId: entry.taskId } : {}), finishedAt: entry.finishedAt, answer };
    },

    async preview(spec) {
      const resolveOptions = { templates: options.templates, library: options.libraryDir, language: options.language };
      // The team session.create would run (resolveWorkflow, ALPD §42): the one chosen, else settings'
      // workflow.mode, else `custom`; a folder without settings gets init's, which name Phở.
      // A preview only reads: a folder the user has not run anything in stays as it is.
      const mapping = await resolveSession(spec, { ...resolveOptions, initialize: false });
      const teams = (await listTeams(spec.cwd, { library: options.libraryDir, templates: options.templates }))
        .filter(team => !team.error)
        .map(team => ({ id: team.id, label: team.label ?? team.id, ...(team.description ? { description: team.description } : {}) }));
      return {
        teams,
        team: mapping.workflow.mode,
        ...(mapping.team?.label ? { teamLabel: mapping.team.label } : {}),
        agent: mapping.agent.name,
        runtime: mapping.runtimeKind,
        model: mapping.model,
        mode: mapping.mode,
        thinking: mapping.thinking,
      };
    },

    syncGates(projectRoot) {
      if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) return Promise.reject(new Error('syncGates needs an absolute projectRoot'));
      return syncGates(projectRoot);
    },

    async board(projectRoot) {
      if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) throw new Error('board needs an absolute projectRoot');
      return (await boardOf(path.resolve(projectRoot))).filter(live);
    },

    questions() {
      return [...userQuestions.values()].map(pending => pending.question);
    },

    message(sessionId, text) {
      const session = openOf(sessionId);
      if (typeof text !== 'string' || !text.trim() || text.length > MAIL_BODY_CHARS) throw new Error(`A message needs text of at most ${MAIL_BODY_CHARS} characters`);
      // Writing to an assignment opens it to the user, and its requester is told.
      if (session.parent) session.userOpened = true;
      post(sessionId, { kind: 'note', from: USER, assignment: sessionId, body: text });
      if (session.parent) tellRequester(sessionId, session, `The user wrote to me directly: "${text}"`);
    },

    answer(questionId, reply) {
      const pending = userQuestions.get(questionId);
      if (!pending) throw new Error(`No question ${questionId} waits for an answer`);
      if (pending.gate) {
        if (!reply.dismiss && (typeof reply.text !== 'string' || !reply.text.trim() || reply.text.length > MAIL_BODY_CHARS)) throw new Error('An answer needs text');
        void pending.gate.decide(reply);
        return;
      }
      if (reply.dismiss) {
        pending.settle('dismissed', undefined, reply.reason);
        return;
      }
      if (typeof reply.text !== 'string' || !reply.text.trim()) throw new Error('An answer needs text');
      if (reply.text.length > MAIL_BODY_CHARS) throw new Error(`An answer is at most ${MAIL_BODY_CHARS} characters`);
      pending.settle('answered', reply.text);
    },

    list() {
      const open = [...sessions].filter(([, session]) => !session.closed && session.threadId);
      const depth = (session: Session) => session.ancestry.length;
      return open.sort(([, a], [, b]) => depth(a) - depth(b)).map(([id, session]) => snapshot(id, session));
    },

    recoverable() {
      return [...inherited];
    },

    recover(rootId, { continueRoot = false, parkedRoot } = {}) {
      return enqueue(() => recoverTree(rootId, continueRoot, parkedRoot));
    },

    async abandon(rootId, reason) {
      const entries = inherited.filter(entry => entry.rootId === rootId);
      inherited = inherited.filter(entry => entry.rootId !== rootId);
      for (const entry of entries) await abandonEntry(entry, reason);
      return entries.map(entry => ({ assignmentId: entry.assignmentId, agent: entry.agent, outcome: 'failed' as const, error: reason }));
    },

    async shutdown() {
      closed = true;

      await queue;

      await Promise.all(
        [...sessions.keys()].map(
          id => closeSession(id),
        ),
      );

      clearInterval(watchdog);
      if (gateWatch) clearInterval(gateWatch);
      await Promise.all(gateSyncs.values());

      // Claims released by the closes above are written before the board is left.
      await Promise.all(boards.values());
      await boardDomain.flush();
      await runLogWrites;
      await forgetting;
      await recalls.flush();
      await inFlight.flush();
      if (limitWatch) clearInterval(limitWatch);
      await Promise.all([...limitChecks.values()].map(check => check.running));
      await pauseWrites;

      listeners.clear();
    },
  };
}
