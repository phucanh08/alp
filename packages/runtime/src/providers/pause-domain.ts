import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { moveFile } from '@anhlp/alp-core/atomic';
import { nativeEnvironment, createTransport } from './providers.ts';
import { optionalRead, usageAllows } from './runtime-context.ts';
import { providerUsage, type ProviderUsage } from './usage.ts';
import type { RuntimeKind } from './resolve.ts';
import { errorData } from '../tools/tool-results.ts';
import { tell } from '../_shared/write-error.ts';
import type { Words } from '../_shared/language.ts';
import type { Pause, PauseState, PromptInput, RuntimeOptions, RuntimeTransport } from '../contracts.ts';
import type { Assignment, Session } from '../sessions/lifecycle/session-state.ts';
import type { AlpEvent, AssignmentSnapshot, SessionSnapshot, TurnOrigin } from '../events.ts';
import type { MailEvent } from '../assignments/mailbox.ts';

/** How often alpd asks a runtime a usage limit paused whether the limit lifted (ALPD §58). */
const LIMIT_CHECK_MS = 60_000;

export const RUNTIMES: RuntimeKind[] = ['codex', 'claude', 'antigravity'];
export const LIMIT_ERRORS = ['usageLimitExceeded', 'rateLimitExceeded'];
export const label = (kind: RuntimeKind) => kind === 'claude' ? 'Claude' : kind === 'acp' ? 'ACP agent' : kind === 'antigravity' ? 'Antigravity' : 'Codex';
export const describePause = (pause: Pause, kind?: RuntimeKind) =>
  `${kind ? label(kind) : 'ALP'} is paused (${pause.reason}${pause.by !== 'alpd' ? `, by ${pause.by}` : ''})${pause.resetsAt ? `; the limit resets ${pause.resetsAt}` : ''}`;

/** Pauses by runtime, or of everything (createAlpRuntime's `paused`). */
export type Pauses = { all?: Pause; runtimes: Partial<Record<RuntimeKind, Pause>> };

type PauseContext = {
  options: RuntimeOptions;
  sessions: Map<string, Session>;
  /** createAlpRuntime's `paused`, which a resume reassigns: every read and write goes through to it. */
  state: { paused: Pauses };
  /** createAlpRuntime's `closed`, read when used. */
  isClosed(): boolean;
  writeFailed(error: unknown): void;
  emit(sessionId: string, event: AlpEvent): void;
  enqueue<T>(work: () => Promise<T>): Promise<T>;
  snapshot(sessionId: string, session: Session): SessionSnapshot;
  rootOf(sessionId: string): string;
  runLog(rootId: string, entry: Record<string, unknown>): void;
  // Declared after this domain in createAlpRuntime: passed as late-bound callbacks.
  notice(level: 'info' | 'warning' | 'error', message: string | ((say: Words) => string), project?: string): void;
  post(sessionId: string, event: Omit<MailEvent, 'id'>): MailEvent;
  deliver(sessionId: string, session: Session): void;
  assignmentSnapshot(assignment: Assignment, status: string): AssignmentSnapshot;
  startPrompt(sessionId: string, prompt: PromptInput, origin: TurnOrigin): Promise<unknown>;
};

/** Pauses, usage limits and parked assignments; the pause file keeps its write order. */
export function createPauseDomain({ options, sessions, state, isClosed, writeFailed, emit, enqueue, snapshot, rootOf, runLog, notice, post, deliver, assignmentSnapshot, startPrompt }: PauseContext) {
  let pauseWrites = Promise.resolve();
  /** The latest usage report of each runtime, and the warnings already given, by runtime and reset time. */
  const usage = new Map<RuntimeKind, any>();
  const warned = new Set<string>();
  /** The check of each runtime's limit running now, and when the last one ended (ALPD §58). */
  const limitChecks = new Map<RuntimeKind, { at: number; running?: Promise<void> }>();
  let limitWatch: NodeJS.Timeout | undefined;
  /** Limit pauses whose lifting the user was told of, when ALP does not resume by itself. */
  const liftTold = new WeakSet<Pause>();
  const pauseOf = (kind: RuntimeKind) => state.paused.all ?? state.paused.runtimes[kind];

  function pauseState(): PauseState {
    return {
      ...(state.paused.all ? { all: state.paused.all } : {}),
      runtimes: { ...state.paused.runtimes },
      parked: [...sessions].filter(([, session]) => session.parked && !session.closed).map(([id, session]) => ({
        assignmentId: id, agent: session.mapping.agent.name, runtime: session.runtimeKind, rootId: rootOf(id), reason: session.parked!.reason, since: new Date(session.parked!.since).toISOString(),
      })),
    };
  }

  function savePauses() {
    const file = options.pauseFile;
    if (!file) return;
    const body = JSON.stringify(state.paused, null, 2) + '\n';
    pauseWrites = pauseWrites.then(async () => {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
      await writeFile(temporary, body, { mode: 0o600 });
      await moveFile(temporary, file);
    }).catch(error => tell(writeFailed, error));
  }

  /**
   * While a usage limit pauses a runtime, alpd asks the runtime every LIMIT_CHECK_MS whether
   * the limit lifted (ALPD §58), so a reset, or a limit the user reset early, is seen without
   * anyone resuming it by hand. Pauses the user made are theirs to lift.
   */
  function watchLimits() {
    const needed = !isClosed() && RUNTIMES.some(kind => state.paused.runtimes[kind]?.by === 'alpd');
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
    const pause = state.paused.runtimes[kind];
    const last = limitChecks.get(kind);
    if (!pause || pause.by !== 'alpd' || isClosed()) return Promise.resolve();
    if (last?.running) return last.running;
    if (last && Date.now() - last.at < fresh) return Promise.resolve();
    const running = (async () => {
      const lifted = await limitLifted(kind).catch(() => undefined);
      limitChecks.set(kind, { at: Date.now() });
      if (state.paused.runtimes[kind] !== pause || isClosed()) return;
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
    return (await readUsageReport(kind, false))?.usage;
  }

  /**
   * As readUsage; with `account`, also the signed-in account's email (usageReport), for daemon.usage
   * alone. The limit watch never asks for it, and the email goes nowhere else (ALPD §58).
   */
  async function readUsageReport(kind: RuntimeKind, account: boolean): Promise<{ usage: unknown; account: { email: string } | null } | undefined> {
    const read = async (runtime: RuntimeTransport) => account && runtime.usageReport
      ? await runtime.usageReport()
      : { usage: ((await runtime.orchestrationContext?.()) as any)?.usage, account: null };
    const open = [...sessions.values()].find(session => !session.closed && !session.pending && session.runtimeKind === kind);
    if (open) return optionalRead(() => read(open.runtime), 20_000);
    let transport: RuntimeTransport | undefined;
    try {
      // A provider that cannot be made (not on PATH, which throws at once on Windows) reads as no usage.
      const made = transport = createTransport(options, kind, os.tmpdir(), nativeEnvironment(options));
      made.onFailure(() => {});
      return await optionalRead(async () => {
        await made.initialize();
        return read(made);
      }, 20_000);
    } catch {
      return undefined;
    } finally {
      await transport?.close().catch(() => {});
    }
  }

  async function limitLifted(kind: RuntimeKind): Promise<boolean | undefined> {
    return usageAllows(await readUsage(kind));
  }

  const usageCache = new Map<'codex' | 'claude', { at: number; pending: boolean; value: Promise<ProviderUsage> }>();
  function cachedUsage(kind: 'codex' | 'claude', refresh = false) {
    const cached = usageCache.get(kind);
    if (cached && (cached.pending || (!refresh && Date.now() - cached.at < 30_000))) return cached.value;
    const value = readUsageReport(kind, true).then(report => providerUsage(kind, report?.usage, undefined, report?.account ?? null), () => providerUsage(kind, undefined));
    const entry = { at: Date.now(), pending: true, value };
    usageCache.set(kind, entry);
    void value.then(() => { entry.pending = false; entry.at = Date.now(); });
    return value;
  }

  function pauseRuntime(scope: RuntimeKind | 'all', pause: Pause, now = false) {
    if (scope === 'all') state.paused.all = pause;
    else { state.paused.runtimes[scope] = pause; limitChecks.delete(scope); }
    savePauses();
    watchLimits();
    if (now) {
      for (const [id, session] of sessions) {
        if (!session.parent || session.closed || !session.active || session.role === 'supervisor' || (scope !== 'all' && session.runtimeKind !== scope)) continue;
        // A process restart already owns its continuation; this pause must not replace its cause.
        if (session.parkReason && !session.parkPause) continue;
        session.parkReason = pause.cause === 'disk' ? pause.reason : `paused by ${pause.by}`;
        session.parkPause = { scope, ...(pause.cause === 'disk' ? { disk: true } : {}) };
        void session.runtime.request('turn/interrupt', { threadId: session.threadId, turnId: session.active }).catch(() => {});
        runLog(rootOf(id), { event: 'assignment.parking', assignmentId: id, agent: session.mapping.agent.name, reason: session.parkReason });
      }
    }
  }

  function resumeRuntime(scope: RuntimeKind | 'all', by: string, keepRuntimes = false) {
    // Lifting alpd's disk pause keeps the usage-limit pauses of single runtimes.
    if (scope === 'all') state.paused = keepRuntimes ? { runtimes: state.paused.runtimes } : { runtimes: {} };
    else delete state.paused.runtimes[scope];
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
    else if (session.parked.pause?.disk) post(session.parent!, { kind: 'stalled', from: assignment.agent, assignment: sessionId, body: `Parked: ${session.parked.reason}. ALP continues this assignment where it stopped as soon as the disk takes writes again (alpd checks every minute), or when the user frees space and runs alp resume. Wait for it, or tell the user the disk is full; what it changed stays in your checkout or its worktree.` });
    else post(session.parent!, { kind: 'stalled', from: assignment.agent, assignment: sessionId, body: `Parked: ${session.parked.reason}. ALP continues this assignment where it stopped when ${label(session.runtimeKind)} is resumed (${options.autoResume !== false && (pauseOf(session.runtimeKind)?.by ?? 'alpd') === 'alpd' ? `ALP resumes it as soon as ${label(session.runtimeKind)} says the limit lifted` : 'the user runs alp resume'}). Wait for it, start other work, or stop it with alp_cancel and give the rest to an agent on another runtime (pass model claude:… or codex:…); what it changed stays in your checkout or its worktree.` });
  }

  function continueParked(sessionId: string, session: Session, expected = session.parked) {
    void enqueue(async () => {
      if (session.closed || session.active || session.pending || !session.parked || session.parked !== expected) return;
      // This continuation owns only the captured park. A pause may have arrived while
      // it waited in the queue; retain the actual blocker for a matching later resume.
      if (pauseOf(session.runtimeKind)) {
        session.parked.pause = { scope: state.paused.all ? 'all' : session.runtimeKind };
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
    if (isClosed() || session.closed || pauseOf(kind)) return;
    const pause: Pause = { since: new Date().toISOString(), by: 'alpd', reason: `${label(kind)} usage limit reached`, ...(resetsAt ? { resetsAt } : {}) };
    pauseRuntime(kind, pause);
    const other = RUNTIMES.find(candidate => candidate !== kind && !pauseOf(candidate));
    notice('error', say => say.limitReached(label(kind), resetsAt, other && label(other), options.autoResume !== false, kind));
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

  /** close(): stops the limit watch, then awaits the running checks and the pause file writes. */
  function stopLimitWatch() {
    if (limitWatch) clearInterval(limitWatch);
  }
  const limitChecksSettled = () => Promise.all([...limitChecks.values()].map(check => check.running));
  const pauseWritesSettled = () => pauseWrites;

  return { pauseOf, pauseState, watchLimits, checkLimit, cachedUsage, pauseRuntime, resumeRuntime, park, continueParked, limitReached, usageReport, stopLimitWatch, limitChecksSettled, pauseWritesSettled };
}
