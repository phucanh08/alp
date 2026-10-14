import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BOARD_KEEP, live, normalizePaths, overlapping, PIN_BODY_CHARS, PIN_KINDS, renderPin, type Pin, type PinKind } from './board.js';
import { plainObject, toolResult } from './tool-results.js';
import type { RuntimeOptions } from './contracts.js';
import type { Session } from './session-state.js';
import type { AlpEvent } from './events.js';
import type { MailEvent } from './mailbox.js';

type BoardContext = {
  options: RuntimeOptions;
  sessions: Map<string, Session>;
  boards: Map<string, Promise<Pin[]>>;
  loadedBoards: Map<string, Pin[]>;
  rootOf(sessionId: string): string;
  lineage(sessionId: string): string[];
  runLog(rootId: string, entry: Record<string, unknown>): void;
  emit(sessionId: string, event: AlpEvent): void;
  post(sessionId: string, event: Omit<MailEvent, 'id'>): MailEvent;
  steerMail(sessionId: string, session: Session): Promise<void>;
};

/** Shared project boards retain their original write ordering and session ownership. */
export function createBoardDomain({ options, sessions, boards, loadedBoards, rootOf, lineage, runLog, emit, post, steerMail }: BoardContext) {
  const boardFile = (project: string) => path.join(options.boardDir!, `${createHash('sha256').update(project).digest('hex').slice(0, 16)}.jsonl`);
  let boardWrites = Promise.resolve();

  /** Live claims, then the most recent decisions and findings. */
  function prune(pins: Pin[]) {
    const notes = pins.filter(pin => pin.kind !== 'claim' && live(pin));
    return [...pins.filter(pin => pin.kind === 'claim' && live(pin)), ...notes.slice(-BOARD_KEEP)];
  }

  /** A board from an earlier daemon keeps its decisions and findings; its claims ended with their sessions. */
  function boardOf(project: string) {
    let board = boards.get(project);
    if (!board) {
      board = (async () => {
        if (!options.boardDir) return [];
        const text = await readFile(boardFile(project), 'utf8').catch(() => '');
        const pins = new Map<string, Pin>();
        for (const line of text.split('\n').filter(Boolean)) {
          try {
            const entry = JSON.parse(line);
            if (entry.pin?.id) pins.set(entry.pin.id, entry.pin);
            else if (entry.release && pins.has(entry.release)) pins.get(entry.release)!.released = entry.at;
          } catch {}
        }
        const now = new Date().toISOString();
        for (const pin of pins.values()) if (pin.kind === 'claim' && !pin.released) pin.released = now;
        const kept = prune([...pins.values()]);
        // Compact the file to what is kept.
        boardWrites = boardWrites.then(async () => {
          await mkdir(options.boardDir!, { recursive: true });
          const temporary = `${boardFile(project)}.${randomUUID().slice(0, 8)}.tmp`;
          await writeFile(temporary, kept.map(pin => JSON.stringify({ pin })).join('\n') + (kept.length ? '\n' : ''));
          await rename(temporary, boardFile(project));
        }).catch(() => {});
        loadedBoards.set(project, kept);
        return kept;
      })();
      boards.set(project, board);
    }
    return board;
  }

  function saveBoard(project: string, entry: object) {
    if (!options.boardDir) return;
    const line = `${JSON.stringify(entry)}\n`;
    boardWrites = boardWrites.then(() => mkdir(options.boardDir!, { recursive: true })).then(() => appendFile(boardFile(project), line)).catch(() => {});
  }

  /** Whether two sessions are in one line of delegation, where a claim is shared. */
  const related = (a: string, b: string) => lineage(a).includes(b) || lineage(b).includes(a);

  /** Live claims of agents outside this session's line of delegation that overlap `paths`. */
  function claimConflicts(sessionId: string, pins: Pin[], paths: string[]) {
    return pins
      .filter(pin => pin.kind === 'claim' && live(pin) && pin.sessionId !== sessionId && !related(sessionId, pin.sessionId) && overlapping(paths, pin.paths ?? []).length)
      .map(pin => ({ pinId: pin.id, agent: pin.agent, sessionId: pin.sessionId, paths: overlapping(pin.paths ?? [], paths), body: pin.body, at: pin.at, ...(pin.task ? { task: pin.task } : {}) }));
  }

  /** The task a session works on: its own assignment's, or the nearest requester's. */
  function taskOf(sessionId: string) {
    for (const id of lineage(sessionId)) {
      const parent = sessions.get(id)?.parent;
      const taskId = parent ? sessions.get(parent)?.assignments.get(id)?.taskId : undefined;
      if (taskId) return taskId;
    }
    return undefined;
  }

  /** Pins to the project board `pins` (from boardOf) and tells agents at work on the project. */
  function addPin(sessionId: string, session: Session, pins: Pin[], fields: Pick<Pin, 'kind' | 'body' | 'paths' | 'task'>) {
    const project = session.mapping.agent.projectRoot;
    const pin: Pin = {
      id: `p-${randomUUID().slice(0, 8)}`, project, kind: fields.kind, body: fields.body, ...(fields.paths ? { paths: fields.paths } : {}), ...(fields.task ? { task: fields.task } : {}),
      agent: session.mapping.agent.name, sessionId, rootId: rootOf(sessionId), at: new Date().toISOString(),
    };
    const kept = prune([...pins, pin]);
    pins.splice(0, pins.length, ...kept);
    saveBoard(project, { pin });
    runLog(pin.rootId, { event: 'board.pin', pinId: pin.id, kind: pin.kind, agent: pin.agent, body: pin.body, ...(pin.paths ? { paths: pin.paths } : {}), ...(pin.task ? { task: pin.task } : {}) });
    emit(sessionId, { type: 'pin', pin });
    // Agents at work on the project read it in their running turn; idle ones see it on alp_board or their next assignment.
    for (const [id, other] of sessions) {
      if (id === sessionId || other.closed || !other.active || other.mapping.agent.projectRoot !== project) continue;
      post(id, { kind: 'board', from: pin.agent, assignment: pin.id, body: renderPin(pin), passive: true });
      if (!other.pending) void steerMail(id, other);
    }
    return pin;
  }

  async function pinTool(sessionId: string, session: Session, args: unknown) {
    if (!plainObject(args, ['kind', 'body', 'paths']) || !PIN_KINDS.includes(args.kind) || typeof args.body !== 'string' || !args.body.trim() || args.body.length > PIN_BODY_CHARS) {
      return toolResult(false, { error: `A pin needs kind (${PIN_KINDS.join(', ')}) and a body of at most ${PIN_BODY_CHARS} characters` });
    }
    // A claim reserves files to change; a read-only session changes none.
    if (args.kind === 'claim' && session.mapping.mode === 'read-only') return toolResult(false, { error: 'A read-only session changes no files and cannot claim paths; pin a decision or finding instead' });
    const project = session.mapping.agent.projectRoot;
    let paths: string[] | undefined;
    if (args.paths !== undefined || args.kind === 'claim') {
      const normalized = normalizePaths(args.paths, project, session.spec.writeRoot ? [session.spec.writeRoot] : undefined);
      if (typeof normalized === 'string') return toolResult(false, { error: normalized });
      paths = normalized;
    }
    const pins = await boardOf(project);
    if (session.closed) return toolResult(false, { error: 'Session closed' });
    if (args.kind === 'claim') {
      const conflicts = claimConflicts(sessionId, pins, paths!);
      if (conflicts.length) {
        return toolResult(false, {
          error: 'Another agent has claimed overlapping paths; do not edit them. Ask your requester, or claim other paths.',
          conflicts,
        });
      }
    }
    const task = args.kind === 'claim' ? taskOf(sessionId) : undefined;
    const pin = addPin(sessionId, session, pins, { kind: args.kind as PinKind, body: args.body, ...(paths ? { paths } : {}), ...(task ? { task } : {}) });
    return toolResult(true, { pinned: pin.id, kind: pin.kind, ...(paths ? { paths } : {}), ...(task ? { task } : {}) });
  }

  async function boardTool(session: Session, args: unknown) {
    if (!plainObject(args, ['kinds', 'limit']) || (args.kinds !== undefined && (!Array.isArray(args.kinds) || !args.kinds.every((kind: unknown) => PIN_KINDS.includes(kind as PinKind)))) || (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1))) {
      return toolResult(false, { error: 'kinds lists claim, decision or finding; limit is a positive integer' });
    }
    const kinds: string[] = args.kinds ?? [...PIN_KINDS];
    const pins = (await boardOf(session.mapping.agent.projectRoot)).filter(pin => live(pin) && kinds.includes(pin.kind));
    const claims = pins.filter(pin => pin.kind === 'claim');
    const notes = pins.filter(pin => pin.kind !== 'claim').slice(-(args.limit ?? 30));
    const view = ({ project: _project, rootId: _root, released: _released, ...pin }: Pin) => pin;
    return toolResult(true, { claims: claims.map(view), notes: notes.map(view) });
  }

  async function unpinTool(sessionId: string, session: Session, args: unknown) {
    if (!plainObject(args, ['pinId']) || typeof args.pinId !== 'string') return toolResult(false, { error: 'pinId is required' });
    const pins = await boardOf(session.mapping.agent.projectRoot);
    const pin = pins.find(candidate => candidate.id === args.pinId && live(candidate));
    if (!pin) return toolResult(false, { error: 'No such pin on this board' });
    if (pin.sessionId !== sessionId) return toolResult(false, { error: `Only ${pin.agent}, who pinned it, can take it down` });
    release(pin, 'unpinned');
    return toolResult(true, { unpinned: pin.id });
  }

  function release(pin: Pin, reason: 'unpinned' | 'session_ended') {
    pin.released = new Date().toISOString();
    saveBoard(pin.project, { release: pin.id, at: pin.released });
    runLog(pin.rootId, { event: 'board.unpin', pinId: pin.id, agent: pin.agent, reason });
    if (sessions.has(pin.sessionId)) emit(pin.sessionId, { type: 'unpin', pinId: pin.id, reason });
    void boardOf(pin.project).then(pins => pins.splice(0, pins.length, ...prune(pins)));
  }

  /** A session's claims end with it. */
  function releaseClaims(sessionId: string, project: string) {
    const board = boards.get(project);
    if (!board) return;
    void board.then(pins => {
      for (const pin of [...pins]) if (pin.kind === 'claim' && live(pin) && pin.sessionId === sessionId) release(pin, 'session_ended');
    });
  }

  return { boardOf, claimConflicts, taskOf, addPin, pinTool, boardTool, unpinTool, releaseClaims, flush: () => boardWrites };
}
