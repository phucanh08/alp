import {
  PROVIDER_PROTOCOL_VERSION,
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  ProviderInputSchema,
  ProviderEventSchema,
  type ProviderRegistration,
  type ProviderEvent,
  type ProviderInput,
  type ProviderContent,
  type ProviderPersistence,
  type ProviderTimelineItem,
} from './compat.js';
import { userPromptPart } from './provider-prompt.js';
import { randomUUID } from 'node:crypto';
import type { AttachmentLimits, DaemonConnection, Envelope, SessionSnapshot, TimelineItem } from '@anhlp/alp-protocol';
import { attachments } from '@anhlp/alp-client/portable';
import { alpdSessionOf, configModels, DEFAULT_TEAM, handleFor, MODES } from './mapping-wire.js';
import { sessionTasks } from './session-tasks.js';
import { paseoDetail } from './tool-detail.js';
import { agentUsage } from './session-usage.js';
import { displayName, mimeOf, storedName, uploadRequestId, type UploadedFile } from './upload-names.js';

/**
 * Paseo is a viewer of alpd: this provider translates Paseo inputs into daemon calls and daemon
 * events into Paseo events. Orchestration lives in the runtime, hosted by alpd (ALPD §8). This core
 * needs only a connection and the protocol: where the connection comes from, and what reads the
 * library or the runtime catalogue, is the strategy's. provider.ts gives the local and embedded
 * ones (alpd on this machine, or in this process); remote/provider.ts reaches alpd through the
 * remote gateway with the client SDK, and never touches this machine's files or processes.
 */

const supported = [
  'prompt.message',
  'prompt.steer',
  'session.persistence',
  'session.subsession',
  'session.configure',
  'session.list',
  'permission',
] as const;

export type ProviderBackend = {
  client: DaemonConnection;
  shutdown(client: DaemonConnection): Promise<void>;
  /**
   * A new connection to alpd after the last one closed. Locally (ALPD §40) it starts alpd unless
   * the user stopped it on purpose and nobody has asked for it since (`demand`); remotely it asks
   * the gateway for a new ticket and connects again.
   */
  relink?(demand: boolean): Promise<DaemonConnection>;
};

export type TeamModel = { id: string; label: string; description?: string; thinkingOptions: never[] };

export type ProviderStrategy = {
  description: string;
  open(): Promise<ProviderBackend>;
  /** The teams a session in `cwd` may run, shown as Paseo's models. */
  teams(cwd: string | undefined, client: DaemonConnection): Promise<TeamModel[]>;
  /** What session.create gets for Paseo's config, and what to tell the user was left out. */
  spec(config: Extract<ProviderInput, { type: 'session.open' }>['config'], persistence: ProviderPersistence | undefined): { spec: Record<string, unknown>; notices?: string[] };
  /** Whether a version 2 handle's directory (alpd's projectRoot) is the project of `cwd`. */
  sameProject?(stored: string, cwd: string): boolean;
  /** The projectRoot to list sessions of for Paseo's cwd. */
  projectRoot(cwd: string | undefined): string | undefined;
  /** A model id's label, for a child's or custom root's config. */
  labelOf?(id: string): { label: string; description?: string } | undefined;
  /** Permission modes to offer, and the default. */
  modes(): { modes: typeof MODES; defaultMode: string };
  /**
   * Follow replay cursors (ALPD §66): on reconnect attach after the last cursor of each root and
   * drop an envelope already seen. Without it a reconnect attaches without replay.
   */
  cursors: boolean;
  /**
   * Send a request once more when it failed because alpd went away and came back. Locally alpd's
   * own restart is the cause; remotely the outcome of a request in flight is unknown, so never.
   */
  repeatAfterRelink: boolean;
  /**
   * Whether a failure to open a new connection is final, so trying again cannot help (remotely: the
   * gateway refused the credential). The sessions then fail with it instead of waiting forever.
   */
  finalLinkError?(error: unknown): boolean;
  /**
   * The bytes of a file Paseo's daemon received through its file upload (uploads.ts), at most
   * `maxBytes`, refusing anything that is not one of Paseo's uploads. Without it (remote: nothing on
   * this machine is read) a prompt with an uploaded file fails and nothing is sent.
   */
  readUpload?(file: UploadedFile, maxBytes: number): Promise<Uint8Array>;
};

/** JSON-RPC codes that settle a root's fate on reattach: gone (1001), refused (1003), malformed. */
const SESSION_GONE = 1001;
const FORBIDDEN = 1003;
const INVALID = new Set([-32601, -32602]);

/**
 * Whether a reattach error is a verdict on the session (it no longer exists, or this credential may
 * no longer see it), by its JSON-RPC code. Anything else (the connection dropped, the gateway lost
 * alpd, a timeout) says nothing about the session: the root is kept and attached again.
 */
export function endsRoot(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  return code === SESSION_GONE || code === FORBIDDEN || (typeof code === 'number' && INVALID.has(code));
}

/** How long a request waits for alpd to come back before it fails. */
const RELINK_WAIT_MS = 20_000;

/** The attachment limits the provider uses: those it checks before a byte moves, from daemon.hello. */
type PromptFileLimits = Pick<AttachmentLimits, 'maxObjectBytes' | 'maxPerPrompt' | 'maxPromptBytes' | 'maxChunkBytes'>;
type AttachmentOffer = { capable: boolean; limits?: PromptFileLimits };
const LIMIT_KEYS = ['maxObjectBytes', 'maxPerPrompt', 'maxPromptBytes', 'maxChunkBytes'] as const;

/**
 * daemon.hello's `attachmentLimits` (§6.1), or undefined when they are missing or malformed: every
 * limit a safe non-negative integer, and the count, prompt and chunk bytes non-zero. Fails closed,
 * as the web's fileLimits does: no protocol default stands in for what alpd did not say.
 */
export function attachmentLimitsOf(offered: unknown): PromptFileLimits | undefined {
  if (!offered || typeof offered !== 'object' || Array.isArray(offered)) return undefined;
  const value = offered as Record<string, unknown>;
  if (!LIMIT_KEYS.every(key => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0)) return undefined;
  const [maxObjectBytes, maxPerPrompt, maxPromptBytes, maxChunkBytes] = LIMIT_KEYS.map(key => value[key] as number);
  if (!maxPerPrompt || !maxPromptBytes || !maxChunkBytes) return undefined;
  return { maxObjectBytes: Math.min(maxObjectBytes, maxPromptBytes), maxPerPrompt, maxPromptBytes, maxChunkBytes };
}

const errorData = (error: unknown) => ({
  message: error instanceof Error ? error.message : String(error),
});

/** A session's config: the profile (or a child's own model), its permission mode; model and effort are fixed. */
const sessionConfig = (strategy: ProviderStrategy, session: SessionSnapshot, thinking: string) => ({
  ...configModels(session, strategy.labelOf),
  mode: session.mode,
  thinkingOption: thinking,
  modes: strategy.modes().modes,
  thinkingOptions: [],
  settings: [],
});

function timelineItem(item: TimelineItem): ProviderTimelineItem {
  if (item.kind === 'user_message') return { type: 'user_message', id: item.id, text: item.text, ...(item.clientMessageId ? { clientMessageId: item.clientMessageId } : {}) };
  if (item.kind === 'assistant_message') return { type: 'assistant_message', id: item.id, text: item.text };
  if (item.kind === 'notice') return { type: 'notification', id: item.id, level: item.level, message: item.text } as ProviderTimelineItem;
  // Paseo shows a compaction as loading until it is done; one that failed shows as a warning.
  if (item.kind === 'compaction') {
    if (item.status === 'failed') return { type: 'notification', id: item.id, level: 'warning', message: 'Compacting the context failed' } as ProviderTimelineItem;
    return { type: 'compaction', id: item.id, status: item.status === 'running' ? 'loading' : 'completed', ...(item.trigger ? { trigger: item.trigger } : {}), ...(item.preTokens !== undefined ? { preTokens: item.preTokens } : {}) } as ProviderTimelineItem;
  }
  if (item.kind === 'todo') return { type: 'todo', id: item.id, items: item.items.map(entry => ({ id: entry.id, text: entry.text, status: entry.status, completed: entry.status === 'completed' })) };
  return {
    type: 'tool_call',
    id: item.id,
    callId: item.callId,
    name: item.name,
    ...(item.status === 'failed' ? { status: item.status, error: item.error ?? 'Tool call failed' } : { status: item.status, error: null }),
    detail: paseoDetail(item.detail),
  } as ProviderTimelineItem;
}

export function createAlpProvider(strategy: ProviderStrategy): ProviderRegistration {
  return {
    id: 'alp',
    label: 'ALP',
    description: strategy.description,

    async connect(request) {
      if (!request.versions.includes(PROVIDER_PROTOCOL_VERSION)) {
        throw new Error('Unsupported Paseo provider protocol version');
      }

      const backend = await strategy.open();
      let client = backend.client;
      // Socket clients have a handshake; embedded clients expose the same offer via hello.
      // An unknown/failed offer never promises images. This advertisement belongs to this
      // provider connection; a replacement backend still validates every submitted prompt.
      let offered = client.capabilities;
      if (offered === undefined) {
        try {
          const hello = await client.request('daemon.hello', { protocolVersion: 1, client: { name: 'alp-paseo', version: '1' } });
          offered = Array.isArray(hello.capabilities) ? hello.capabilities : [];
        } catch { offered = []; }
      }
      const capabilities = negotiateProviderCapabilities(
        request.capabilities,
        [...supported, ...(offered?.includes('prompt.images') ? ['prompt.image' as const] : [])],
      );

      const delegation = capabilities.includes('session.subsession');
      /** Questions to the user appear as Paseo question prompts on the root agent; without them, answer with the CLI. */
      const asksUser = capabilities.includes('permission');
      const questionRoots = new Map<string, string>();
      /** Roots this connection opened; children belong to their root. */
      const roots = new Set<string>();
      const listeners = new Set<(event: ProviderEvent) => void>();
      /** Request ids of client-initiated opens; children are opened by the runtime. */
      const opening = new Map<string, string>();
      /** Paseo names a resumed or imported root afresh; alpd keeps the original id. */
      const alpdIds = new Map<string, string>();
      const paseoIds = new Map<string, string>();
      const toAlpd = (sessionId: string) => alpdIds.get(sessionId) ?? sessionId;
      const toPaseo = (sessionId: string) => paseoIds.get(sessionId) ?? sessionId;
      let closed = false;
      /** Roots' directories, to reopen one that alpd no longer has open after a restart. */
      const cwds = new Map<string, string>();
      /** Roots alpd did not reopen after a restart: the next prompt reopens them. */
      const dormant = new Set<string>();
      /** A reconnection to alpd in progress; `demanded` once the user asks for something meanwhile. */
      let relinking: Promise<void> | undefined;
      let demanded = false;
      let lastError: unknown;
      /** Set when reconnecting cannot help (finalLinkError): requests fail with it. */
      let dead: unknown;
      /** Cuts a backoff short when the provider closes. */
      let wakeBackoff: (() => void) | undefined;
      /** Each alpd session's root, and the last replay cursor seen of each root's timeline. */
      const rootOf = new Map<string, string>();
      const cursors = new Map<string, number>();
      const treeRoot = (alpdId: string) => {
        let current = alpdId;
        for (let depth = 0; depth < 64; depth++) { const parent = rootOf.get(current); if (!parent || parent === current) return current; current = parent; }
        return current;
      };

      const emit = (event: ProviderEvent) => {
        const checked = ProviderEventSchema.parse(event);
        for (const listener of listeners) listener(checked);
      };

      /**
       * One alpd envelope to Paseo. `replayed`: it arrived while reattaching, so it happened while this
       * view was away (§8.3).
       */
      function project(envelope: Envelope, replayed = false) {
        const { event } = envelope;
        if (event.type === 'session.opened' && !rootOf.has(envelope.sessionId)) rootOf.set(envelope.sessionId, event.session.parentId ?? envelope.sessionId);
        if (strategy.cursors && typeof envelope.cursor === 'number') {
          // One cursor sequence per tree: what replay after a reconnect sends again is dropped.
          const root = treeRoot(envelope.sessionId);
          if (envelope.cursor <= (cursors.get(root) ?? 0)) return;
          cursors.set(root, envelope.cursor);
        }
        const sessionId = toPaseo(envelope.sessionId);
        switch (event.type) {
          case 'session.opened': {
            const { session } = event;
            // A root Paseo already shows, reopened after alpd restarted: only its config may have changed.
            if (roots.has(sessionId) && !opening.has(envelope.sessionId)) {
              emit({ type: 'session.config', sessionId, config: sessionConfig(strategy, { ...session, model: event.effective.model }, event.effective.thinking) });
              return;
            }
            const parentId = session.parentId && toPaseo(session.parentId);
            emit({
              type: 'session.opened',
              requestId: opening.get(envelope.sessionId) ?? `open-${sessionId}`,
              sessionId,
              cwd: event.cwd,
              capabilities,
              restoration: parentId ? 'parent' : 'core',
              ...(parentId
                ? { parentSessionId: parentId, toolCallId: session.toolCallId, title: `ALP ${session.agent} (${session.runtime})` }
                : {}),
              ...(session.persistent ? { persistence: handleFor(session) } : {}),
            });
            emit({ type: 'session.config', sessionId, config: sessionConfig(strategy, { ...session, model: event.effective.model }, event.effective.thinking) });
            return;
          }
          case 'session.ready':
            if (roots.has(sessionId) && !opening.has(envelope.sessionId)) return;
            emit({ type: 'session.ready', requestId: opening.get(envelope.sessionId) ?? `open-${sessionId}`, sessionId });
            return;
          case 'session.updated': {
            const { session } = event;
            emit({ type: 'session.config', sessionId, config: sessionConfig(strategy, session, session.thinking) });
            return;
          }
          case 'session.closed':
            // alpd closes an idle root nobody watches, as it did while this view was away: Paseo
            // keeps the session, and the next prompt reopens it (wake). Live closes still reach Paseo.
            if (replayed && roots.has(sessionId)) { dormant.add(sessionId); return; }
            emit({ type: 'session.closed', sessionId });
            return;
          case 'session.failed':
            emit({ type: 'session.runtime_failed', sessionId, error: event.error });
            return;
          case 'prompt.accepted':
            emit({ type: 'session.prompt_result', sessionId, clientMessageId: event.clientMessageId, result: { type: event.result, turnId: event.turnId } });
            return;
          case 'prompt.failed':
            emit({ type: 'session.prompt_result', sessionId, clientMessageId: event.clientMessageId, result: { type: 'failed', error: event.error } });
            return;
          case 'turn.started':
            emit({ type: 'session.turn', sessionId, turnId: event.turnId, state: 'started' });
            return;
          case 'turn.ended':
            emit({ type: 'session.turn', sessionId, turnId: event.turnId, state: event.state, ...(event.error ? { error: event.error } : {}) });
            return;
          case 'usage':
            // The session's whole latest usage (t-7679.12): Paseo keeps it as the agent's lastUsage for its context meter.
            emit({ type: 'session.usage', sessionId, usage: agentUsage(event.usage) });
            return;
          case 'item':
            // A todo list of tasks becomes the Tasks pill's, not Paseo's own pill (ALPD §55).
            if (event.item.kind === 'todo') { sessionTasks.set(sessionId, event.item.items.map(entry => entry.id)); return; }
            emit({ type: 'timeline.item', sessionId, item: timelineItem(event.item) });
            return;
          case 'question': {
            const { question } = event;
            if (!asksUser) return;
            const root = toPaseo(question.rootId);
            questionRoots.set(question.id, root);
            emit({
              type: 'session.permission',
              sessionId: root,
              request: {
                id: question.id,
                name: 'alp_ask',
                kind: 'question',
                title: `${question.agent} asks you`,
                description: question.body,
                input: { questions: [{ id: '0', header: 'Answer', question: question.body, options: (question.options ?? []).map(label => ({ label })), isOther: true, allowOther: true }] },
                metadata: { agent: question.agent, alpSessionId: question.sessionId },
              },
            });
            return;
          }
          case 'question.resolved': {
            const root = questionRoots.get(event.questionId);
            if (!root) return;
            questionRoots.delete(event.questionId);
            emit({ type: 'session.permission_resolved', sessionId: root, permissionId: event.questionId });
            return;
          }
          // Mail and assignments reach Paseo through the agents' own timelines; the board through alp board.
          case 'mail':
          case 'assignment':
          case 'pin':
          case 'unpin':
            return;
        }
      }

      const notify = (sessionId: string, level: 'info' | 'warning' | 'error', message: string) =>
        emit({ type: 'timeline.item', sessionId, item: { type: 'notification', id: `alp-link-${randomUUID()}`, level, message } as ProviderTimelineItem });

      function wire(connection: DaemonConnection) {
        connection.onEvent(project);
        // An older connection closing after a reconnect is not news.
        connection.onClose(error => { if (connection === client) lost(error); });
      }

      /** alpd went away. In-process backends end their sessions; alpd is started again and its sessions picked up. */
      function lost(error: unknown) {
        if (closed || dead) return;
        if (!backend.relink) {
          for (const sessionId of roots) emit({ type: 'session.runtime_failed', sessionId, error: errorData(error) });
          roots.clear();
          return;
        }
        // A reconnection in progress replaces this connection; it checks the new one is alive before it is used.
        if (relinking) return;
        for (const sessionId of roots) notify(sessionId, 'warning', `ALP lost its connection to alpd (${errorData(error).message}); reconnecting. Work that was running continues once alpd is back.`);
        relinking = relink().finally(() => {
          relinking = undefined;
          // The connection just adopted may have closed while this one wound down: go again.
          if (!closed && !dead && client.closed) lost(lastError ?? new Error('ALP daemon connection closed'));
        });
      }

      const backoff = (attempt: number) => new Promise<void>(resolve => {
        const timer = setTimeout(done, Math.min(250 * 2 ** attempt, 5_000));
        function done() { clearTimeout(timer); wakeBackoff = undefined; resolve(); }
        wakeBackoff = done;
      });

      /**
       * Opens connections until one stays up while every root is attached again. A connection that
       * drops meanwhile, or a root that fails for a reason other than its own end (endsRoot), makes
       * the attempt fail: that connection is closed and a new one tried after a backoff, with roots,
       * cursors and ids kept. Only reads are sent here (session.get, session.attach, both safe to
       * repeat); a request the user made is never sent again.
       */
      async function relink() {
        for (let attempt = 0; !closed; attempt++) {
          let next: DaemonConnection | undefined;
          const stops: Array<() => void> = [];
          try {
            next = await backend.relink!(demanded);
            if (closed) { next.close(); return; }
            let dropped: unknown;
            // Replay arrives before each attach answer, so events are projected from the start.
            stops.push(next.onEvent(envelope => project(envelope, true)));
            stops.push(next.onClose(error => { dropped ??= error ?? new Error('ALP daemon connection closed'); }));
            for (const sessionId of [...roots]) {
              if (closed) break;
              if (dropped !== undefined || next.closed) throw dropped ?? new Error('ALP daemon connection closed');
              await reattach(next, sessionId);
            }
            if (closed) { next.close(); return; }
            if (dropped !== undefined || next.closed) throw dropped ?? new Error('ALP daemon connection closed');
            for (const stop of stops) stop();
            client = next;
            wire(next);
            demanded = false;
            lastError = undefined;
            for (const sessionId of roots) notify(sessionId, 'info', 'ALP reconnected to alpd.');
            return;
          } catch (error) {
            lastError = error;
            for (const stop of stops) stop();
            if (next && next !== client) { try { next.close(); } catch {} }
            if (strategy.finalLinkError?.(error)) {
              dead = error;
              for (const sessionId of roots) emit({ type: 'session.runtime_failed', sessionId, error: errorData(error) });
              roots.clear();
              return;
            }
            if (closed) return;
            await backoff(attempt);
          }
        }
      }

      /**
       * Follows a root again on `connection`; one alpd did not reopen waits for its next prompt. Only
       * an error that ends the root (endsRoot) fails it; any other is thrown so the attempt retries.
       */
      async function reattach(connection: DaemonConnection, sessionId: string) {
        const alpdId = toAlpd(sessionId);
        try {
          const { session } = await connection.request('session.get', { sessionId: alpdId });
          if (strategy.cursors) {
            // What happened while away is replayed before the answer, in cursor order (§8.3).
            const answer = await connection.request('session.attach', { sessionId: alpdId, after: cursors.get(alpdId) ?? 0 });
            if (answer?.reset) {
              // alpd's timeline restarted below what this view had: its replay was dropped as seen.
              if (typeof answer.cursor === 'number') cursors.set(alpdId, answer.cursor);
              notify(sessionId, 'warning', 'ALP could not continue this session\'s history from where this view left it; reopen the session to see it whole.');
            }
          } else {
            await connection.request('session.attach', { sessionId: alpdId, replay: false });
          }
          if (session.status === 'idle' || session.status === 'running') dormant.delete(sessionId);
          else dormant.add(sessionId);
        } catch (error) {
          if (!endsRoot(error)) throw error;
          roots.delete(sessionId);
          dormant.delete(sessionId);
          emit({ type: 'session.runtime_failed', sessionId, error: errorData(error) });
        }
      }

      /** Reopens a dormant root before it is used, unless alpd reopened it meanwhile. */
      async function wake(sessionId: string) {
        if (!dormant.has(sessionId)) return;
        const alpdId = toAlpd(sessionId);
        const { session } = await client.request('session.get', { sessionId: alpdId });
        if (session.status !== 'idle' && session.status !== 'running') {
          // Its own mode again: a credential limited to some modes must name one (remote gateway §5.3).
          await client.request('session.create', { sessionId: alpdId, spec: { cwd: cwds.get(sessionId) ?? session.projectRoot, ...(session.mode ? { mode: session.mode } : {}) }, resume: true, delegation });
        }
        dormant.delete(sessionId);
      }

      /** Waits for alpd when it is coming back; asking makes it start even after a deliberate stop. */
      async function linked() {
        if (dead) throw dead;
        if (!relinking) return;
        demanded = true;
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`alpd is not reachable${lastError ? `: ${errorData(lastError).message}` : ''}; ALP keeps trying to start it`)), RELINK_WAIT_MS); });
        try { await Promise.race([relinking, timeout]); } finally { clearTimeout(timer); }
      }

      wire(client);

      /**
       * What a connection offers for attachments, from its daemon.hello answer (§6.1; repeating it
       * answers the same): whether it lists capability `attachments` (the connection's handshake
       * capabilities when it has them, else that answer's) and its effective `attachmentLimits`.
       * Fails closed like the web's fileLimits: no answer, no capability, or limits missing or not
       * safe non-negative integers (counts, prompt and chunk bytes non-zero) mean no files. A failed
       * hello is not kept, so the next prompt asks again.
       */
      const offers = new WeakMap<DaemonConnection, Promise<AttachmentOffer>>();
      function attachmentOffer(connection: DaemonConnection) {
        let offer = offers.get(connection);
        if (!offer) {
          offer = connection.request('daemon.hello', { protocolVersion: 1, client: { name: 'alp-paseo', version: '1' } })
            .then((hello: any) => {
              const listed = connection.capabilities ?? (Array.isArray(hello?.capabilities) ? hello.capabilities : []);
              return { capable: listed.includes('attachments'), limits: attachmentLimitsOf(hello?.attachmentLimits) };
            });
          offers.set(connection, offer);
          offer.catch(() => { if (offers.get(connection) === offer) offers.delete(connection); });
        }
        return offer;
      }

      /**
       * A prompt's content for alpd: each `uploaded_file` part becomes an attachment part in its place
       * (§12.6), inline images stay intact, and contextual attachments become ordinary user text.
       * Plain text bodies and part order are preserved. The files Paseo's
       * daemon stored are read (strategy.readUpload, confined to Paseo's uploads) and uploaded into
       * alpd's store for this session under a requestId of this prompt and part, so the same prompt
       * sent again resumes or reuses the same upload and object. Every check that can refuse a file
       * runs before any byte moves: reader, capability, limits, count and declared sizes, then every
       * file is read and checked (each at most maxObjectBytes, all at most maxPromptBytes, so memory
       * stays bounded by one message) before the first upload begins. Only alpd itself can still fail
       * an upload after an earlier one committed; that object is unreferenced, is reused by the same
       * prompt sent again, and alpd's retention removes it otherwise. Refusals name files, never host
       * paths.
       */
      async function promptContent(sessionId: string, clientMessageId: string, content: ProviderContent[]) {
        const normalized = content.map(userPromptPart);
        const files = normalized.filter(part => part.type === 'uploaded_file') as unknown as UploadedFile[];
        if (!files.length) return normalized;
        const names = files.map(file => displayName(file.fileName)).join(', ');
        if (!strategy.readUpload) throw new Error(`ALP cannot attach ${names}: files uploaded to Paseo are not sent to this ALP host`);
        const connection = client;
        let offer: AttachmentOffer;
        try {
          offer = await attachmentOffer(connection);
        } catch (error) {
          throw new Error(`ALP cannot attach ${names}: alpd did not say whether it takes file attachments (${errorData(error).message})`);
        }
        if (!offer.capable) throw new Error(`ALP cannot attach ${names}: this alpd does not take file attachments`);
        const { limits } = offer;
        if (!limits) throw new Error(`ALP cannot attach ${names}: this alpd names no valid attachment limits`);
        if (files.length > limits.maxPerPrompt) throw new Error(`ALP cannot attach ${files.length} files to one message; at most ${limits.maxPerPrompt}`);
        const declared = files.reduce((sum, file) => sum + (Number.isSafeInteger(file.size) && file.size > 0 ? file.size : 0), 0);
        if (declared > limits.maxPromptBytes) throw new Error(`ALP cannot attach ${names}: together they are larger than one message takes (${limits.maxPromptBytes} bytes)`);
        // Read and check every file before uploading any, so a refused file leaves nothing in alpd.
        const read = new Map<number, Uint8Array>();
        let total = 0;
        for (const [index, part] of normalized.entries()) {
          if (part.type !== 'uploaded_file') continue;
          const data = await strategy.readUpload(part as unknown as UploadedFile, limits.maxObjectBytes);
          total += data.byteLength;
          if (total > limits.maxPromptBytes) throw new Error(`ALP cannot attach ${names}: together they are larger than one message takes (${limits.maxPromptBytes} bytes)`);
          read.set(index, data);
        }
        const store = attachments(connection);
        const parts: Array<(typeof normalized)[number] | { type: 'attachment'; attachmentId: string }> = [];
        for (const [index, part] of normalized.entries()) {
          if (part.type !== 'uploaded_file') { parts.push(part); continue; }
          const file = part as unknown as UploadedFile;
          let attachment;
          try {
            attachment = await store.upload({ sessionId, name: storedName(file.fileName), mimeType: mimeOf(file.mimeType), data: read.get(index)!, requestId: uploadRequestId(sessionId, clientMessageId, index), maxChunkBytes: limits.maxChunkBytes });
          } catch (error) {
            // alpd's errors name no host path (§12.6); the file is named by its display name.
            throw Object.assign(new Error(`ALP could not attach ${displayName(file.fileName)}: ${errorData(error).message}`), { code: (error as { code?: unknown })?.code, data: (error as { data?: unknown })?.data });
          }
          parts.push({ type: 'attachment', attachmentId: attachment.attachmentId });
        }
        return parts;
      }

      async function handle(input: ProviderInput) {
        // Prompt capabilities are checked below after the native-command refusal.
        if (input.type !== 'session.prompt') requireProviderCapabilities(capabilities, input);

        if (input.type === 'catalog') {
          emit({
            type: 'catalog',
            requestId: input.requestId,
            catalog: {
              models: await strategy.teams(input.cwd, client),
              modes: strategy.modes().modes,
              thinkingOptions: [],
              defaultModel: DEFAULT_TEAM,
              defaultMode: strategy.modes().defaultMode,
            },
          });
          return;
        }

        if (input.type === 'sessions') {
          const { sessions } = await client.request('session.list', { projectRoot: strategy.projectRoot(input.cwd), rootsOnly: true, includeClosed: true });
          const query = input.query?.toLowerCase();
          emit({
            type: 'sessions',
            requestId: input.requestId,
            sessions: sessions
              .filter((session: any) => session.persistent && (!query || `${session.title ?? ''} ${session.agent}`.toLowerCase().includes(query)))
              .slice(0, input.limit ?? 50)
              .map((session: any) => ({
                persistence: handleFor(session),
                cwd: session.projectRoot,
                title: session.title ? `${session.agent}: ${session.title}` : `ALP ${session.agent}`,
                description: `${session.teamLabel ?? 'ALP'} · ${session.runtime}:${session.model} · ${session.status}`,
                ...(session.updatedAt ? { updatedAt: session.updatedAt } : {}),
              })),
          });
          return;
        }

        if (input.type === 'session.open') {
          const named = alpdSessionOf(input.config, input.persistence, strategy.sameProject);
          const { spec, notices = [] } = strategy.spec(input.config, input.persistence);
          const alpdId = named ?? input.sessionId;
          opening.set(alpdId, input.requestId);
          alpdIds.set(input.sessionId, alpdId);
          paseoIds.set(alpdId, input.sessionId);
          try {
            await client.request('session.create', { sessionId: alpdId, spec, history: input.history, delegation, resume: named !== undefined });
            roots.add(input.sessionId);
            rootOf.set(alpdId, alpdId);
            cwds.set(input.sessionId, typeof spec.cwd === 'string' ? spec.cwd : input.config.cwd);
            for (const notice of notices) notify(input.sessionId, 'warning', notice);
          } catch (error) {
            alpdIds.delete(input.sessionId);
            paseoIds.delete(alpdId);
            throw error;
          } finally {
            opening.delete(alpdId);
          }
          return;
        }

        if (!('sessionId' in input)) {
          throw new Error(
            `Unsupported operation '${input.type}'`,
          );
        }

        // The answer to a question an agent asked the user.
        if (input.type === 'session.permission') {
          const { response } = input;
          if (response.behavior === 'allow') {
            const answers = (response.updatedInput as { answers?: Record<string, unknown> } | undefined)?.answers ?? {};
            const text = [answers.Answer, ...Object.values(answers)].find((value): value is string => typeof value === 'string' && !!value.trim());
            if (!text) throw new Error('Type an answer before submitting');
            await client.request('question.answer', { questionId: input.permissionId, text });
          } else {
            await client.request('question.answer', { questionId: input.permissionId, dismiss: true, ...(response.message ? { reason: response.message } : {}) });
          }
          return;
        }

        if (input.type === 'session.prompt') {
          const { prompt } = input;
          // alpd has no native-command prompt contract. Never turn a command into user
          // prose or send an incomplete command part; reject before waking a session.
          if (prompt.input.type === 'command') throw new Error('ALP does not support native command prompts');
          requireProviderCapabilities(capabilities, input);
          await wake(input.sessionId);
          const sessionId = toAlpd(input.sessionId);
          await client.request('session.prompt', {
            sessionId,
            clientMessageId: prompt.clientMessageId,
            delivery: prompt.delivery === 'steer' ? 'steer' : 'auto',
            content: await promptContent(sessionId, prompt.clientMessageId, prompt.input.content),
          });
          return;
        }

        // The daemon checks that the session is open, in order with earlier inputs.
        if (input.type === 'session.configure') {
          if (input.changes.model !== undefined || input.changes.settings?.workflow !== undefined) throw new Error('The team is fixed for this session; choose another team when creating a new session');
          if (Object.keys(input.changes).some(key => key !== 'mode')) throw new Error('Only permission mode can be changed in an existing ALP session');
          await wake(input.sessionId);
          await client.request('session.configure', { sessionId: toAlpd(input.sessionId), mode: input.changes.mode === undefined ? undefined : input.changes.mode ?? 'read-only' });
        } else if (input.type === 'session.close') {
          // Closing a view: alpd closes the session once idle, or lets running work finish.
          await client.request('session.release', { sessionId: toAlpd(input.sessionId) });
          roots.delete(input.sessionId);
          cwds.delete(input.sessionId);
          dormant.delete(input.sessionId);
        } else if (input.type === 'session.interrupt') {
          await client.request('session.interrupt', { sessionId: toAlpd(input.sessionId) });
        } else {
          throw new Error(
            `Unsupported operation '${input.type}'`,
          );
        }

        emit({ type: 'request.completed', requestId: input.requestId });
      }

      return {
        version:
          PROVIDER_PROTOCOL_VERSION,
        capabilities,

        onEvent(listener) {
          listeners.add(listener);

          return () => {
            listeners.delete(listener);
          };
        },

        async send(raw) {
          if (closed) {
            throw new Error(
              'Provider connection is closed',
            );
          }

          const input =
            ProviderInputSchema.parse(
              raw,
            );

          try {
            // Refuse unsupported native commands even while disconnected: no relink,
            // retry, session wake or daemon request is needed to know this limitation.
            if (input.type === 'session.prompt' && input.prompt.input.type === 'command') {
              await handle(input);
              return;
            }
            await linked();
            try {
              await handle(input);
            } catch (error) {
              // The request beat the news that alpd went away: wait for it to come back and try once more.
              if (!strategy.repeatAfterRelink || !backend.relink || closed || !client.closed) throw error;
              lost(error);
              await linked();
              await handle(input);
            }
          } catch (error) {
            if (input.type === 'session.prompt') {
              emit({ type: 'session.prompt_result', sessionId: input.sessionId, clientMessageId: input.prompt.clientMessageId, result: { type: 'failed', error: errorData(error) } });
            } else if (
              'requestId' in input
            ) {
              emit({
                type: 'request.failed',
                requestId:
                  input.requestId,
                error:
                  errorData(error),
              });
            } else {
              throw error;
            }
          }
        },

        async close() {
          closed = true;
          wakeBackoff?.();
          await Promise.all([...roots].map(sessionId => client.request('session.release', { sessionId: toAlpd(sessionId) }).catch(() => {})));
          roots.clear();
          await backend.shutdown(client);
          listeners.clear();
        },
      };
    },
  };
}
