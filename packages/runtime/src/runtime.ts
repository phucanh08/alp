import { constants as fsConstants } from 'node:fs';
import type { Session, Assignment, Waiter } from './session-state.js';
import { errorData, plainObject, toolResult } from './tool-results.js';
import { createLogger } from '@anhlp/alp-core/log';
import { createBoardDomain } from './board-domain.js';
import { createWorktreeDomain } from './worktree-domain.js';
import { DEFAULT_TEAM, type RuntimeTransport, type RuntimeOptions, type OpenOptions, type PromptContent, type PromptInput, type AlpRuntime, type SessionPreview, type RecoveryOutcome, type Pause, type PauseState, type RecallAnswer } from './contracts.js';
export type { RuntimeTransport, RuntimeOptions, OpenOptions, PromptContent, PromptInput, AlpRuntime, SessionPreview, RecoveryOutcome, Pause, PauseState, RecallAnswer } from './contracts.js';
export { DEFAULT_TEAM } from './contracts.js';
import { verdictLine, parseHandoff, type Handoff } from './handoff.js';
import { TASK_ACTIONS, TASK_PAST, TASK_FIELDS, mainOf, roleOf, taskActions, taskBrief, type TaskAction } from './tools.js';
import { nativeEnvironment, createTransport } from './providers.js';
import { nativeMode, codexApproval, profileEfforts, nativeSessionConfig } from './session-config.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { appendFile, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveDelegation } from '@anhlp/alp-core/delegation';
import { discoverAgents } from '@anhlp/alp-core/resolver';

import { acpDecision, acpWhat, type AcpPermission } from './acp-transport.js';

import { models, modes, thinkingOptionsFor, withinMode, writes } from './catalog.js';
import { runHook } from '@anhlp/alp-core/hook-run';
import { hookMatches } from '@anhlp/alp-core/hooks';
import { isTrusted, trustProject } from '@anhlp/alp-core/trust';
import { listTeams } from '@anhlp/alp-core/teams';
import { anyModel, offers, profileModel, selectedProfile } from '@anhlp/alp-core/profiles';
import { LESSONS_FILE, READ_ONLY_AGENTS, resolveSession, type ResolvedSession, type RuntimeKind, type SessionSpec } from './resolve.js';
import { MAIL_BODY_CHARS, publicEvent, renderMail, takeBatch, USER, type MailEvent } from './mailbox.js';
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
import { ALP_REPO, gh, projectRepo } from './github.js';
import { optionalRead, usageAllows, COMPACT_SHARE } from './runtime-context.js';
import { providerUsage, type ProviderUsage } from './usage.js';
import { parse as toml } from 'smol-toml';
import { findFormula, formulaDirs, listFormulas, pourFormula } from '@anhlp/alp-core/formulas';
import { addAllowRule, capMode, commandDecision, profileFor, unwrapShell } from '@anhlp/alp-core/permissions';
import { addGate, checkGates, resolveGate, blockersOf, childrenOf, closeTask, epicReport, releaseOrphans, createTask, getTask, linkTask, listTasks, loadTasks, readyTasks, releaseTask, reopenTask, retakeTask, startRefusal, startTask, submitTask, summarize, taskDigest, updateTask, type Task } from '@anhlp/alp-core/tasks';

const MAX_WAKES = 8;
/** How long the user may wait for main's first words before its tool results remind it. */
const USER_REPLY_MS = 60_000;

/** What a waiting session hears when the user wrote to it. */
const USER_WROTE = 'The user just wrote to you; their message follows. Answer them first in a short message they can read (tool calls alone show them nothing), and steer an assignment with alp_send when their words change its brief. Your assignments keep running: then alp_wait again, or end your turn and ALP wakes you with their results.';
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

/** How much of an assignment's brief ALP repeats after a compaction. */
const BRIEF_CHARS = 8000;
// Placeholder delivery marks while a steer or a woken turn is starting.
const STEERING = '\u0000steering';
const STARTING = '\u0000starting';

/** Answers that approve a proposal; anything else is feedback. */
const APPROVALS = ['approve', 'approved', 'yes', 'y', 'ok', 'đồng ý', 'duyệt', 'có'];
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

export function createAlpRuntime(options: RuntimeOptions = {}): AlpRuntime {
  const sessions = new Map<string, Session>();
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
  const sequences = new Map<string, number>();

  let closed = false;
  let queue = Promise.resolve();

  const emit = (sessionId: string, event: AlpEvent) => {
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
      ...(session.parked ? { parked: session.parked.reason } : {}),
      ...(session.instructionsSha ? { instructionsSha: session.instructionsSha } : {}),
      busy: !!(session.active || session.pending || session.children.size || session.assignments.size || hasActiveMail(session) || reviewing(session)),
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
    cancelQuestions(sessionId);
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
      // Answering the supervisor is not reviewed again, or the two would loop.
      if (session.supervisorWake) session.journal.length = 0;
      else review(sessionId);
    }
    if (session.role === 'supervisor' && session.parent && sessions.get(session.parent)?.reviewPending) review(session.parent);
    if (!session.parent) void showTasks(sessionId, session);

    // An assignment a limit or a pause stopped waits, open, to continue instead of ending.
    if (session.parkReason && state !== 'completed') {
      park(sessionId, session);
      return;
    }
    session.parkReason = undefined;

    // A requester is not done while its assignments run or mail awaits it.
    if (state === 'completed' && (session.assignments.size || hasActiveMail(session))) {
      queueMicrotask(() => deliver(sessionId, session));
      return;
    }

    session.settle?.(state, error);
  }

  function nativeItem(
    sessionId: string,
    session: Session,
    item: any,
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
      const text = (item.content ?? [])
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');
      emit(sessionId, { type: 'item', item: { kind: 'user_message', id: item.id, text } });
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

      emit(sessionId, {
        type: 'item',
        item: {
          kind: 'tool_call',
          id: item.id,
          callId: item.id,
          name: 'shell',
          status,
          ...(status === 'failed' ? { error: 'Command failed' } : {}),
          detail: {
            type: 'shell',
            command: item.command,
            cwd: item.cwd,
            output: item.aggregatedOutput ?? '',
            exitCode: item.exitCode,
          },
        },
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
        nativeItem(sessionId, session, params.item);
      }
      if (method === 'item/started' && params.item?.type === 'commandExecution') watchCopy(sessionId, session, params.item);
      if (method === 'item/started' && params.item) skillUse(sessionId, session, params.item);
      return;
    }

    if (method === 'account/rateLimits/updated') {
      usageReport(session, params);
      return;
    }

    if (method === 'thread/tokenUsage/updated') {
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
        if (session.parent && session.role !== 'supervisor') session.parkReason = `the ${label(session.runtimeKind)} usage limit was reached`;
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

  async function closeSession(sessionId: string) {
    const session = sessions.get(sessionId);
    if (!session || session.closed) return;

    session.closed = true;
    cancelQuestions(sessionId);
    releaseClaims(sessionId, session.mapping.agent.projectRoot);

    await Promise.all(
      [...session.children, ...(session.supervisor ? [session.supervisor] : [])].map(closeSession),
    );

    terminal(sessionId, session, 'canceled');
    session.settle?.('canceled', 'Session closed');

    await session.runtime.close();

    // Copies of assignments that did not finish hold nothing to keep.
    for (const assignment of session.assignments.values()) if (assignment.copy && !assignment.finished) await removeCopy(assignment.copy).catch(() => {});

    for (const [assignmentId, { worktree }] of session.worktrees) {
      await removeWorktree(worktree).catch(() => {});
      runLog(rootOf(sessionId), { event: 'worktree.kept', assignmentId, branch: worktree.branch });
    }
    session.worktrees.clear();

    sessions.delete(sessionId);

    if (session.parent) {
      const parent = sessions.get(session.parent);
      parent?.children.delete(sessionId);
      if (parent?.supervisor === sessionId) parent.supervisor = undefined;
    }

    // Kept: a session resumed in this runtime goes on from its last seq, so (epoch, seq) never repeats.
    emit(sessionId, { type: 'session.closed' });
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
  const userQuestions = new Map<string, { question: UserQuestion; settle: (outcome: 'answered' | 'dismissed' | 'timeout' | 'canceled', answer?: string, reason?: string, result?: unknown) => void }>();
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
      const { kind, until, ref, gate, formula: _formula, vars: _vars, ...fields } = input;
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
        : action === 'gate' ? await addGate(project, id, { kind, note, until, ref }, by)
        : action === 'clear' ? await resolveGate(project, id, gate, { by, note })
        : action === 'link' ? await linkTask(project, id, { add, remove }, by)
        : action === 'start' ? await startTask(project, id, { agent: by, session: sessionId }, by)
        : action === 'close' ? await hookedClose(id)
        : await reopenTask(project, id, { note }, by);
      touchTask(rootOf(sessionId), task.id);
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
  const held = (session: Session) => !!session.parked || !!pauseOf(session.runtimeKind);
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
      await rename(temporary, file);
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
        session.parkReason = `paused by ${pause.by}`;
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
    const free = RUNTIMES.filter(kind => !pauseOf(kind));
    if (free.length) notice('info', say => say.resumed(scope === 'all' ? 'ALP' : label(scope), by, pauseState().parked.length > 0));
    for (const [id, session] of sessions) {
      if (session.closed || pauseOf(session.runtimeKind)) continue;
      if (session.parked) continueParked(id, session);
      else if (session.wakeHeld) { session.wakeHeld = false; deliver(id, session); }
    }
  }

  /** An assignment whose turn a limit or a pause ended stays open, and its requester learns why. */
  function park(sessionId: string, session: Session) {
    session.parked = { reason: session.parkReason!, since: Date.now() };
    const then = session.parkThen;
    session.parkReason = undefined;
    session.parkThen = undefined;
    emit(sessionId, { type: 'session.updated', session: snapshot(sessionId, session) });
    const parent = session.parent ? sessions.get(session.parent) : undefined;
    const assignment = parent?.assignments.get(sessionId);
    runLog(rootOf(sessionId), { event: 'assignment.parked', assignmentId: sessionId, agent: session.mapping.agent.name, reason: session.parked.reason });
    if (!parent || !assignment) return;
    emit(session.parent!, { type: 'assignment', assignment: assignmentSnapshot(assignment, 'parked') });
    // One that continues by itself is information; one held until the user resumes needs the requester's decision, so it wakes it.
    if (then) post(session.parent!, { kind: 'note', from: assignment.agent, assignment: sessionId, passive: true, body: `Parked: ${session.parked.reason}. ${then} Wait for it, or start other work.` });
    else post(session.parent!, { kind: 'stalled', from: assignment.agent, assignment: sessionId, body: `Parked: ${session.parked.reason}. ALP continues this assignment where it stopped when ${label(session.runtimeKind)} is resumed (${options.autoResume !== false && (pauseOf(session.runtimeKind)?.by ?? 'alpd') === 'alpd' ? `ALP resumes it as soon as ${label(session.runtimeKind)} says the limit lifted` : 'the user runs alp resume'}). Wait for it, start other work, or stop it with alp_cancel and give the rest to an agent on another runtime (pass model claude:… or codex:…); what it changed stays in your checkout or its worktree.` });
  }

  function continueParked(sessionId: string, session: Session) {
    const { reason, prompt } = session.parked!;
    session.parked = undefined;
    session.wakeHeld = false;
    session.lastActivity = Date.now();
    emit(sessionId, { type: 'session.updated', session: snapshot(sessionId, session) });
    const parent = session.parent ? sessions.get(session.parent) : undefined;
    const assignment = parent?.assignments.get(sessionId);
    runLog(rootOf(sessionId), { event: 'assignment.resumed', assignmentId: sessionId, agent: session.mapping.agent.name });
    if (assignment) emit(session.parent!, { type: 'assignment', assignment: assignmentSnapshot(assignment, 'running') });
    void startPrompt(sessionId, {
      clientMessageId: `alp-resume-${randomUUID()}`,
      delivery: 'auto',
      content: [{ type: 'text', text: prompt ?? `ALP resumed this assignment; it had stopped because ${reason}. Continue where you left off: your earlier work in this session and its files are intact. Finish with alp_handoff as before.` }],
    }, session.parent ? 'assignment' : 'wake').catch(error => session.settle?.('failed', error));
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
    if (paused.runtimes[kind]?.by === 'alpd') return;
    const resetsAt = await limitReset(session, error);
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
    if (failed) return;
    session.contextLevel = 0;
    if (session.supervisor) session.journal.push(stamp(`${agent}'s context was compacted`));
    if (session.role !== 'supervisor') void restoreAfterCompaction(sessionId, session).catch(() => {});
  }

  /** What ALP holds of a session's work, told to it after a compaction (ALPD §57). */
  async function restoreAfterCompaction(sessionId: string, session: Session) {
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
    const asked = [...userQuestions.values()].filter(pending => pending.question.sessionId === sessionId);
    if (asked.length) parts.push('Waiting for the user to answer:\n' + asked.map(pending => `- ${clip(pending.question.body, 300)}`).join('\n'));
    if (!session.parent) {
      const project = session.mapping.agent.projectRoot;
      const tasks = await loadTasks(project).then(({ tasks, errors }) => taskDigest(tasks, errors), () => '');
      if (tasks) parts.push(tasks);
      const board = renderBoard(await boardOf(project));
      if (board) parts.push(board);
    }
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
  async function confirm(sessionId: string, session: Session, body: string): Promise<{ approved: boolean; feedback?: string; outcome?: string }> {
    if ([...userQuestions.values()].some(pending => pending.question.sessionId === sessionId)) return { approved: false, outcome: 'busy', feedback: 'A question is already waiting for the user' };
    const say = wordsFor(session);
    const result = await askUser(sessionId, session, undefined, body, [say.approve, say.reject]) as { contentItems: Array<{ text: string }> };
    let value: any;
    try { value = JSON.parse(result.contentItems[0].text); } catch { value = {}; }
    if (value.status !== 'answered') return { approved: false, outcome: value.status ?? 'canceled', ...(value.reason ? { feedback: value.reason } : {}) };
    const answer = String(value.answer).trim();
    return APPROVALS.includes(answer.toLowerCase()) ? { approved: true } : { approved: false, outcome: 'answered', feedback: answer };
  }

  const declined = (decision: { feedback?: string; outcome?: string }) => toolResult(true, {
    approved: false,
    outcome: decision.outcome,
    ...(decision.feedback ? { feedback: decision.feedback } : {}),
    next: 'Nothing was saved or posted. Revise from the feedback and propose again, or drop it.',
  });

  const text = (value: unknown, limit: number) => typeof value === 'string' && !!value.trim() && value.length <= limit;

  async function skillTool(sessionId: string, session: Session, args: unknown) {
    if (
      !plainObject(args, ['name', 'description', 'body', 'roles', 'lessons', 'replace']) ||
      typeof args.name !== 'string' || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(args.name) ||
      !text(args.description, 300) || !text(args.body, SKILL_BODY_CHARS) ||
      !Array.isArray(args.roles) || !args.roles.length || args.roles.length > 10 || !args.roles.every((role: unknown) => typeof role === 'string' && /^[\w.-]+$/.test(role) && role !== '.' && role !== '..') ||
      (args.lessons !== undefined && (!Array.isArray(args.lessons) || args.lessons.length > 50 || !args.lessons.every((lesson: unknown) => text(lesson, LESSON_CHARS)))) ||
      (args.replace !== undefined && typeof args.replace !== 'boolean')
    ) {
      return toolResult(false, { error: `A skill needs a name (lowercase letters, digits, hyphens), a one-line description, a body of at most ${SKILL_BODY_CHARS} characters, and the roles that get it` });
    }
    if (!options.libraryDir) return toolResult(false, { error: 'This host keeps no user skill library' });
    const known = new Set([...STARTER_ROLES, ...await discoverAgents(session.mapping.agent.projectRoot, { library: options.libraryDir, templates: options.templates })]);
    const unknown = args.roles.filter((role: string) => !known.has(role));
    if (unknown.length) return toolResult(false, { error: `Unknown roles: ${unknown.join(', ')}. Roles are ${[...known].join(', ')}` });
    const file = path.join(options.libraryDir, 'skills', args.name, 'SKILL.md');
    const existing = await readFile(file, 'utf8').catch(() => undefined);
    if (existing !== undefined && !args.replace) return toolResult(false, { error: `The library already has a skill named ${args.name} (${file}); read it, then pass replace: true to propose a new version, or choose another name` });
    const rolesFile = path.join(options.libraryDir, 'role-skills.json');
    const readRoles = async () => {
      const raw = await readFile(rolesFile, 'utf8').catch(() => '{}');
      const roles = JSON.parse(raw);
      if (!roles || typeof roles !== 'object' || Array.isArray(roles)) throw new Error(`${rolesFile} must be an object of role names to skill lists`);
      return roles as Record<string, unknown>;
    };
    try { await readRoles(); } catch (error) { return toolResult(false, { error: errorData(error).message }); }
    const content = `---\nname: ${args.name}\ndescription: ${JSON.stringify(args.description.replace(/\s+/g, ' ').trim())}\n---\n\n${args.body.trim()}\n`;
    const lessons: string[] = (args.lessons ?? []).map((lesson: string) => lesson.replace(/\s+/g, ' ').trim());
    const say = wordsFor(session);
    const decision = await confirm(sessionId, session,
      say.skill(session.mapping.agent.name, existing !== undefined, file, args.roles.join(', '), lessons) +
      `\n${say.answerLine(session.mapping.agent.name)}\n\n${content}`);
    if (!decision.approved) return declined(decision);
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
      return toolResult(false, { error: errorData(error).message });
    }
    // The lessons the skill replaces leave both files; a lesson matches only by its exact text.
    const removed = new Set<string>();
    for (const lessonFile of lessonFiles(session.mapping)) {
      const current = await readFile(lessonFile, 'utf8').catch(() => undefined);
      if (current === undefined) continue;
      const kept = current.split('\n').filter(line => {
        const match = /^- \d{4}-\d\d-\d\d: (.*)$/.exec(line);
        if (!match || !lessons.includes(match[1].trim())) return true;
        removed.add(match[1].trim());
        return false;
      });
      if (kept.length !== current.split('\n').length) await writeFile(lessonFile, kept.join('\n')).catch(() => {});
    }
    runLog(rootOf(sessionId), { event: 'skill', agent: session.mapping.agent.name, name: args.name, roles: args.roles, replaced: existing !== undefined, lessons: [...removed] });
    return toolResult(true, {
      approved: true, saved: file, roles: args.roles, lessonsRemoved: [...removed],
      ...(lessons.length > removed.size ? { lessonsNotFound: lessons.filter(lesson => !removed.has(lesson)) } : {}),
      next: 'New sessions of those roles list the skill; read the file now if you need it in this one.',
    });
  }

  async function issueTool(sessionId: string, session: Session, args: unknown) {
    if (!plainObject(args, ['action', 'target', 'query', 'title', 'body', 'issue', 'labels']) || !['search', 'create', 'comment'].includes(args.action) || !['project', 'alp'].includes(args.target)) {
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
    const where = `${repo}${args.target === 'alp' ? ' (ALP itself)' : ''}`;
    const say = wordsFor(session);
    const decision = await confirm(sessionId, session,
      say.issue(session.mapping.agent.name, args.action === 'create', args.issue, where) + '\n' +
      `${say.answerLine(session.mapping.agent.name)}\n\n` +
      (args.action === 'create' ? `${say.issueTitle}: ${args.title}\n${args.labels?.length ? `${say.issueLabels}: ${args.labels.join(', ')}\n` : ''}\n` : '') + args.body);
    if (!decision.approved) return declined(decision);
    const body = args.body.trim() + ISSUE_FOOTER;
    try {
      const output = args.action === 'create'
        ? await github(['issue', 'create', '-R', repo, '--title', args.title, '--body-file', '-', ...(args.labels ?? []).flatMap((label: string) => ['--label', label])], { cwd: project, input: body })
        : await github(['issue', 'comment', String(args.issue), '-R', repo, '--body-file', '-'], { cwd: project, input: body });
      const url = output.trim().split('\n').at(-1) ?? '';
      runLog(rootOf(sessionId), { event: 'issue', action: args.action, repo, ...(args.title ? { title: args.title } : {}), ...(args.issue ? { issue: args.issue } : {}), url });
      return toolResult(true, { approved: true, posted: true, repo, url });
    } catch (error) {
      return toolResult(false, { approved: true, posted: false, repo, error: errorData(error).message, next: 'Tell the user; the GitHub CLI may need `gh auth login`.' });
    }
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
    if (session.pending) {
      void session.acknowledged.then(() => deliver(sessionId, session));
    } else if (session.active) {
      // Deferred mail waits for the turn to end.
      if (session.mail.some(event => !event.deliveredTurn && !event.passive && !event.defer)) void steerMail(sessionId, session);
    } else if (!waking) {
      return;
    } else if (!session.wakeBlocked && session.wakes < MAX_WAKES) {
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
      emit(sessionId, { type: 'item', item: { kind: 'user_message', id: `user:${id}`, clientMessageId: id, text } });
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
    if (held(session)) { session.wakeHeld = true; return; }
    const batch = takeBatch(session.mail, () => true);
    if (!batch.length) return;
    for (const event of batch) event.deliveredTurn = STARTING;
    const release = () => {
      for (const event of batch) if (event.deliveredTurn === STARTING) event.deliveredTurn = undefined;
    };
    const work = queue.then(async () => {
      if (closed || session.closed) return release();
      // Whatever ran first decides: a running turn gets the mail by steering, an interrupt holds it.
      if (session.wakeBlocked || session.active || session.pending) {
        release();
        return deliver(sessionId, session);
      }
      if (!batch.every(event => event.kind === 'checkin')) session.wakes++;
      const id = `alp-wake-${randomUUID()}`;
      try {
        await startPrompt(sessionId, { clientMessageId: id, delivery: 'auto', content: [{ type: 'text', text: renderMail(batch, session.parentAgent) }] }, 'wake', batch);
      } catch {
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
    options, leases, rootOf, lineage, runLog, runHooks, touchTask,
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
    // alpd is stopping: the assignment stays in the live file and its task stays in progress, for the next alpd to continue.
    if (closed && inFlight.get(assignment.id)) {
      runLog(assignment.rootId, { event: 'assignment.interrupted', assignmentId: assignment.id, agent: assignment.agent, reason: 'alpd stopped' });
      await closeSession(assignment.id);
      if (assignment.lease && leases.get(assignment.lease)?.assignment === assignment.id) leases.delete(assignment.lease);
      childContexts.delete(assignment.id);
      parent.children.delete(assignment.id);
      parent.assignments.delete(assignment.id);
      return;
    }
    // Removed before anything else, so a crash while finishing never runs finished work again.
    void inFlight.remove(assignment.id);
    const child = sessions.get(assignment.id);
    if (child && state === 'failed' && child.active) terminal(assignment.id, child, 'failed', error);
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

    await closeSession(assignment.id);
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

    childContexts.delete(assignment.id);
    parent.children.delete(assignment.id);
    parent.assignments.delete(assignment.id);
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
      !['alp_delegate', 'alp_handoff', 'alp_wait', 'alp_cancel', 'alp_send', 'alp_ask', 'alp_merge', 'alp_discard', 'alp_recall', 'alp_verify', 'alp_pin', 'alp_board', 'alp_unpin', 'alp_lesson', 'alp_skill', 'alp_issue', 'alp_task'].includes(params.tool) ||
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
    if (!events) return toolResult(false, { error: 'Turn ended' });
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
  function askUser(sessionId: string, session: Session, assignment: Assignment | undefined, body: string, options?: string[]) {
    const rootId = rootOf(sessionId);
    const question: UserQuestion = {
      id: `q-${randomUUID().slice(0, 8)}`,
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
      userQuestions.set(question.id, { question, settle });
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

  /** Questions to the user end with the turn or session that asked them. */
  function cancelQuestions(sessionId: string) {
    for (const { question, settle } of [...userQuestions.values()]) {
      if (question.sessionId === sessionId) settle('canceled', undefined, undefined, toolResult(false, { error: 'Turn ended' }));
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
    if (assignment?.ask || [...userQuestions.values()].some(pending => pending.question.sessionId === sessionId)) {
      return Promise.resolve(toolResult(false, { error: 'A question is already waiting for an answer' }));
    }
    // Only main talks to the user, unless the user has written to this assignment first.
    if (to === 'user' && session.parent && !session.userOpened) {
      return Promise.resolve(toolResult(false, { error: `Only main talks to the user; ask ${session.parentAgent ?? 'your requester'} with alp_ask instead` }));
    }
    if (to === 'user') return askUser(sessionId, session, assignment, args.question, args.options);
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

  async function runDelegation(
    sessionId: string,
    session: Session,
    params: any,
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

    if (root.calls >= 16) {
      return toolResult(false, {
        error: 'Delegation limit reached for this turn',
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
    root.calls++;
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
        // The new branch holds the earlier change, so its worktree and branch can go.
        if (continued) await removeWorktree(continued.worktree, { deleteBranch: true }).catch(() => {});
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
      await openSession(childId, childSpec, 'skip', session.delegation);

      const child = sessions.get(childId);
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
      return toolResult(false, {
        agent: args.agent,
        assignmentId: childId,
        status: 'canceled',
        error: 'Parent assignment stopped',
      });
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

  async function openSession(sessionId: string, spec: SessionSpec, history: 'replay' | 'skip', delegation = true): Promise<SessionSnapshot> {
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
      journal: [],
      tasks: [],

      children: new Set(),
      peerCount: 0,
      assignments: new Map(),
      calls: 0,
      mail: [],
      waiters: [],
      lastActivity: Date.now(),
      wakes: 0,
      wakeBlocked: false,

      toolCalls: new Map(),
      acknowledged: Promise.resolve(),
      worktrees: new Map(),
    };

    sessions.set(
      sessionId,
      session,
    );

    wire(sessionId, session, runtime);

    try {
      await runtime.initialize();

      if (session.closed) {
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

      const result = mapping.threadId
        ? await runtime.request(
            'thread/resume',
            {
              ...nativeConfig,
              threadId:
                mapping.threadId,
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

      if (session.closed) {
        throw new Error(
          'Session closed during thread creation',
        );
      }

      session.pending = false;
      session.buffered = [];

      emit(sessionId, {
        type: 'session.opened',
        session: snapshot(sessionId, session),
        cwd: result.cwd ?? mapping.workdir,
        effective: {
          model: result.model ?? mapping.model,
          thinking: result.reasoningEffort ?? mapping.thinking,
        },
      });

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
      session.closed = true;
      sessions.delete(
        sessionId,
      );

      await runtime.close();

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
      if (session.closed || session.runtime !== transport) return;
      if (revivable(session)) void revive(sessionId, session, error);
      else failSession(sessionId, session, error);
    });
  }

  function failSession(sessionId: string, session: Session, error: unknown) {
    log.error(`${session.mapping.agent.name}'s ${session.runtimeKind} session failed`, { code: 'ALP_PROVIDER_FAILED', sessionId, rootId: rootOf(sessionId), agent: session.mapping.agent.name, provider: session.runtimeKind, error });
    terminal(sessionId, session, 'failed', error);
    session.settle?.('failed', error);
    void closeSession(sessionId);
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
    if (session.active) {
      session.parkReason = `its ${harness} process stopped`;
      session.parkThen = `ALP is restarting the ${harness} process; this assignment continues by itself.`;
      terminal(sessionId, session, 'failed', error);
    }
    const old = session.runtime;
    void old.close().catch(() => {});
    try {
      const transport = createTransport(options, session.runtimeKind, session.mapping.workdir, nativeEnvironment(options, session.mapping.env), session.mapping.acp, session.mapping.antigravity);
      session.runtime = transport;
      session.pending = true;
      wire(sessionId, session, transport);
      await transport.initialize();
      const config = await configOf(session);
      if (session.closed) return void transport.close().catch(() => {});
      await transport.request('thread/resume', { ...config, threadId: session.threadId });
      if (session.closed) return void transport.close().catch(() => {});
      session.pending = false;
      session.buffered = [];
      runLog(rootOf(sessionId), { event: 'session.revived', sessionId, agent: session.mapping.agent.name });
      if (session.parked && !pauseOf(session.runtimeKind)) {
        session.parked.prompt = `ALP restarted your ${harness} process after it stopped in the middle of your turn. Continue where you left off: your earlier work in this session and its files are intact.${session.parent ? ' Finish with alp_handoff as before.' : ''}`;
        continueParked(sessionId, session);
      }
    } catch (failure) {
      session.pending = false;
      session.parked = undefined;
      runLog(rootOf(sessionId), { event: 'session.revive_failed', sessionId, agent: session.mapping.agent.name, error: errorData(failure).message });
      failSession(sessionId, session, error);
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
      if (assignment.worktree) await removeWorktree(assignment.worktree).catch(() => {});
    };
    try {
      if (entry.lease) {
        const holder = [...leases].find(([key]) => overlapping([entry.lease!], [key]).length)?.[1];
        if (holder && !lineage(entry.parentId).includes(holder.assignment)) throw new Error(`${holder.agent} writes ${entry.lease} now`);
        if (!holder) { assignment.lease = entry.lease; leases.set(entry.lease, { assignment: id, agent: entry.agent }); }
      }
      if (entry.worktree) assignment.worktree = await reattachWorktree(entry.worktree);
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
      await openSession(id, { ...spec, restore: { agent: entry.agent, threadId: entry.threadId, runtime: entry.runtime, model: entry.model, workflow: parent.mapping.workflow } }, 'skip', entry.delegation);
      const child = sessions.get(id)!;
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
  async function recoverTree(rootId: string, continueRoot: boolean): Promise<RecoveryOutcome[]> {
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
        session.parked = { reason: cause, since: Date.now(), prompt: text };
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
    if (continueRoot) proceed(rootId, root, `ALP: ${cause} during your turn, and reopened this session. Continue the user's request where you stopped.${listed(resumed.get(rootId))}`);
    else for (const assignment of resumed.get(rootId) ?? []) post(rootId, { kind: 'note', from: assignment.agent, assignment: assignment.id, passive: true, body: `${cause}; ALP reopened this assignment and it continues. It reports when done.` });
    const failed = outcomes.filter(outcome => outcome.outcome === 'failed');
    if (entries.length || continueRoot) {
      const parked = outcomes.some(outcome => outcome.outcome === 'parked') || (continueRoot && !!root.parked);
      notice(failed.length ? 'warning' : 'info',
        `ALP: ${cause}${options.previousExit?.at ? ` (around ${options.previousExit.at})` : ''}. ` +
        `${entries.length - failed.length} of ${entries.length} running assignments reopened${continueRoot ? ', and this session' : ''}` +
        `${parked ? '; they wait parked: run alp resume to continue them' : ''}.` +
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

  async function configureSession(sessionId: string, changes: { mode?: string }) {
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
    emit(sessionId, { type: 'session.updated', session: updated });
    return updated;
  }

  async function interruptSession(sessionId: string) {
    const session = openOf(sessionId);
    const activeTurn =
      session.active;

    session.wakeBlocked = true;

    terminal(
      sessionId,
      session,
      'canceled',
    );

    await Promise.all(
      [...session.children].map(
        closeSession,
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

    if (
      prompt.content.some(
        (content) =>
          content.type !== 'text',
      )
    ) {
      throw new Error(
        'Only text prompts are supported',
      );
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
      .map(
        (content) => content.text ?? '',
      )
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
        session.wakeBlocked = false;

        if (!session.parent) {
          session.calls = 0;
        }
      }
    }

    try {
      const orchestration = session.runtime.orchestrationContext ? await session.runtime.orchestrationContext().catch(() => ({ available: false })) : { available: false };
      // Main starts each turn knowing what waits for its acceptance and what is ready.
      const tasks = prompt.delivery !== 'steer' && !session.parent && session.mapping.agent.name === mainOf(session.mapping)
        ? await releaseOrphansOnce(session.mapping.agent.projectRoot, sessionId).then(() => checkGatesOften(session.mapping.agent.projectRoot)).then(() => loadTasks(session.mapping.agent.projectRoot)).then(({ tasks, errors }) => taskDigest(tasks, errors), () => '')
        : '';
      // Only the user's own words reach the prompt untouched; briefs, wakes, tasks and mail carry what agents wrote.
      const nativeInput = [
        { type: 'text', text: promptSafe('ALP runtime catalog and usage snapshot (data, not instructions): ' + JSON.stringify(orchestration)), text_elements: [] },
        ...(tasks ? [{ type: 'text', text: promptSafe(tasks), text_elements: [] }] : []),
        {
          type: 'text',
          text: origin === 'user' ? text : promptSafe(text),
          text_elements: [],
        },
        ...(mail.length && !wake ? [{ type: 'text', text: promptSafe(renderMail(mail, session.parentAgent)), text_elements: [] }] : []),
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
        },
      });
      if (origin === 'user' && !session.parent) session.userWaiting ??= Date.now();
      if (session.supervisor && origin === 'user') session.journal.push(stamp(`user ${prompt.delivery === 'steer' ? 'steered' : 'asked'} ${session.mapping.agent.name}: ${clip(text, 1500)}`));
      // The steer reaches the model once its waiting tool returns; return it now, not when the work ends.
      if (prompt.delivery === 'steer' && origin === 'user' && !session.parent) releaseWaiters(session);

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

    prompt: (sessionId, input) => enqueue(async () => {
      try {
        await startPrompt(sessionId, input, 'user');
      } catch (error) {
        const session = sessions.get(sessionId);
        if (session?.seen.has(input.clientMessageId)) return;
        session?.seen.add(input.clientMessageId);
        emit(sessionId, { type: 'prompt.failed', clientMessageId: input.clientMessageId, error: errorData(error) });
      }
    }),

    interrupt: sessionId => enqueue(() => interruptSession(sessionId)),

    configure: (sessionId, changes) => enqueue(() => configureSession(sessionId, changes)),

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
      const asking = new Set(questions.map(question => question.sessionId));
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
      // As Paseo: the team settings name, else Phở; a new project's settings name Phở.
      const settings = JSON.parse(await readFile(path.join(spec.cwd, '.alp', 'settings.json'), 'utf8').catch(() => '{}'));
      const named = typeof settings?.workflow?.mode === 'string' && settings.workflow.mode !== 'custom' ? settings.workflow.mode : undefined;
      const workflow = spec.workflow ?? named ?? DEFAULT_TEAM;
      // A preview only reads: a folder the user has not run anything in stays as it is.
      const mapping = await resolveSession({ ...spec, workflow }, { ...resolveOptions, initialize: false });
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

    recover(rootId, { continueRoot = false } = {}) {
      return enqueue(() => recoverTree(rootId, continueRoot));
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
          closeSession,
        ),
      );

      clearInterval(watchdog);

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
