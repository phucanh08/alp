// @ts-check
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ERROR, PROTOCOL_VERSION, RPC_ERROR } from '@anhlp/alp-protocol';
import { validateParams } from '@anhlp/alp-protocol/contract';
import { isAlpClientError } from '@anhlp/alp-client/portable';
import { CONTENT_TYPES, FORWARDED_CAPABILITIES, GATEWAY_ERROR, GATEWAY_REASON, LIBRARY_ROW_FIELDS, MODEL_ROW_FIELDS, SPEC_FIELDS, TEAM_ROW_FIELDS, exposureOf, isModelId, workspaceOf } from './policy.js';

/**
 * One remote client of the gateway (docs/alp/remote-gateway.md §3, §6): its WebSocket, its own
 * connection to alpd through the client SDK, and everything in between. alpd attaches trees and
 * delivers their events per connection, so each client gets its own daemon connection: no
 * response or event of one client can be routed to another, and when a client goes away its
 * daemon connection closes, which is exactly what alpd does for a local viewer that leaves (a
 * busy session keeps working; nothing is cancelled).
 *
 * Every request goes through the checks of docs/protocol/alp-json-rpc-v1.md §5.2, then the
 * exposure matrix (policy.js), the v1 schema, the grant's permission and the resource scope,
 * before one request goes to alpd. Requests are never resent. Responses and events leave in one
 * ordered queue, so replayed events still arrive before the session.attach response that ends
 * them (§8.3).
 */

/** WebSocket close codes the gateway uses (docs/alp/remote-gateway.md §6.4). */
export const CLOSE_CODE = Object.freeze({
  /** Gateway shutting down: reconnect later. */
  goingAway: 1001,
  /** A message over the frame limit (sent by the ws library). */
  tooLarge: 1009,
  /** An internal failure, such as an event whose scope could not be checked: reconnect and replay. */
  internal: 1011,
  /** A binary message: not an ALP frame (as the client SDK's 4003). */
  unsupportedData: 4003,
  /** The credential was revoked, rotated or expired: authenticate again. */
  unauthorized: 4401,
  /** The credential's grant changed: authenticate again. */
  grantChanged: 4403,
  /** No daemon.hello in time. */
  handshakeTimeout: 4408,
  /** Requests kept arriving after the rate limit refused them. */
  rateLimited: 4429,
  /** The client did not read fast enough; reconnect and replay from its cursor. */
  slowConsumer: 4431,
  /** The gateway lost, or could not open, its connection to alpd. */
  daemonUnavailable: 4503,
});

/** How far up a tree the scope check walks before it gives up and refuses. */
const MAX_DEPTH = 32;
/** Scope decisions remembered per connection; past this the cache starts again. */
const MAX_CACHED = 10_000;
/** Events question.watch sends of trees a client did not attach, as copies without a cursor. */
const WATCHED = new Set(['question', 'question.resolved', 'turn.ended']);

/** A path relative to a workspace, under it: no root, drive, `.`/`..` or empty segment, no NUL. @param {unknown} file */
function relativeFile(file) {
  if (typeof file !== 'string' || !file || file.length > 4096 || file.includes('\0')) return false;
  if (/^[\\/]/.test(file) || /^[A-Za-z]:/.test(file)) return false;
  return file.split(/[\\/]/).every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

/** alpd pages one session.list page may read when the grant leaves out what alpd lists. */
const MAX_LIST_READS = 8;
/** At most this many projectRoots go to alpd's session.list (its schema's limit). */
const MAX_LIST_PROJECTS = 1024;

/**
 * session.list cursors leave the gateway sealed (AES-256-GCM, a key of this process, the credential
 * as associated data): alpd's own cursor names the last session it read, which may be one the grant
 * leaves out, and a client may continue only from a cursor this gateway gave its credential.
 */
const CURSOR_KEY = randomBytes(32);
const CURSOR_PREFIX = 'g1.';

/** @param {string} cursor @param {string} principal */
function sealCursor(cursor, principal) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', CURSOR_KEY, iv);
  cipher.setAAD(Buffer.from(principal, 'utf8'));
  const body = Buffer.concat([cipher.update(cursor, 'utf8'), cipher.final()]);
  return CURSOR_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

/** alpd's cursor inside a sealed one, or undefined for anything else. @param {string} token @param {string} principal */
function openCursor(token, principal) {
  if (!token.startsWith(CURSOR_PREFIX)) return undefined;
  try {
    const raw = Buffer.from(token.slice(CURSOR_PREFIX.length), 'base64url');
    if (raw.length <= 28) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', CURSOR_KEY, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(principal, 'utf8'));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}

/**
 * @typedef {{
 *   maxPending: number, rate: number, burst: number, maxStrikes: number, handshakeMs: number,
 *   requestTimeoutMs: number, maxBufferedBytes: number, maxQueue: number, closeGraceMs: number,
 * }} ConnectionLimits
 * @typedef {{ client: import('@anhlp/alp-client/portable').AlpRpcClient, hello: Record<string, any> }} Upstream
 * @typedef {{ root: string, projectRoot: string, mode?: string }} Scoped
 */

class GatewayError extends Error {
  /** @param {number} code @param {string} message @param {Record<string, unknown>} [data] */
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** A session the client may not see; `outside` tells existing-elsewhere from missing, for the gateway only. */
class NotInScope extends GatewayError {
  /** @param {string} id @param {'missing' | 'outside'} why */
  constructor(id, why) {
    super(ERROR.notFound, `No session ${id}`);
    this.why = why;
  }
}

const forbidden = (/** @type {string} */ message, /** @type {string} */ reason, extra = {}) => new GatewayError(GATEWAY_ERROR.forbidden, message, { reason, ...extra });

/** A request id v1 accepts (docs/protocol/alp-json-rpc-v1.md §3). @param {unknown} id */
function validId(id) {
  if (typeof id !== 'string') return Number.isSafeInteger(id);
  let length = 0;
  for (const _point of id) if (++length > 128) return false;
  return true;
}

/** The listed params that are present. @param {Record<string, unknown>} params @param {readonly string[]} keys */
function pick(params, keys) {
  /** @type {Record<string, unknown>} */
  const picked = {};
  for (const key of keys) if (Object.hasOwn(params, key) && params[key] !== undefined) picked[key] = params[key];
  return picked;
}

export class ClientConnection {
  /** @type {import('ws').WebSocket} */ #ws;
  /** @type {import('./credentials.js').Grant} */ #grant;
  /** @type {ConnectionLimits} */ #limits;
  /** @type {import('@anhlp/alp-core/log').Logger} */ #log;
  /** @type {Upstream['client'] | undefined} */ #up;
  /** @type {Promise<void>} */ #ready;
  /** @type {Record<string, any>} */ #daemonHello = {};
  /** @type {string[]} */ #capabilities = [];
  /** @type {Map<string, Scoped>} */ #sessions = new Map();
  /** Sessions whose watched questions were found outside the grant. @type {Set<string>} */ #outside = new Set();
  /** Roots this client attached (session.create, session.attach) and has not released. */
  /** @type {Set<string>} */ #attached = new Set();
  /** After question.watch: the workspace it named, or null for every one of the grant. */
  /** @type {import('./credentials.js').Workspace | null | undefined} */ #watch;
  /** @type {Array<{ frame: string | null | undefined }>} */ #queue = [];
  #queuedBytes = 0;
  #helloed = false;
  /** A hello waiting for alpd: requests pipelined behind it wait too, as alpd answers hello at once. */
  /** @type {Promise<unknown> | undefined} */ #helloing;
  #closed = false;
  #upstreamGone = false;
  #pending = 0;
  #tokens;
  #lastRefill = Date.now();
  #strikes = 0;
  #alive = true;
  /** @type {Array<ReturnType<typeof setTimeout>>} */ #timers = [];
  /** @type {(connection: ClientConnection, code: number) => void} */ #onClosed;

  /**
   * @param {{
   *   ws: import('ws').WebSocket, grant: import('./credentials.js').Grant, id: string,
   *   connectUpstream: () => Promise<Upstream>, limits: ConnectionLimits,
   *   logger: import('@anhlp/alp-core/log').Logger, onClosed: (connection: ClientConnection, code: number) => void,
   * }} options
   */
  constructor({ ws, grant, id, connectUpstream, limits, logger, onClosed }) {
    this.id = id;
    this.principal = grant.id;
    this.#ws = ws;
    this.#grant = grant;
    this.#limits = limits;
    this.#log = logger;
    this.#onClosed = onClosed;
    this.#tokens = limits.burst;
    ws.on('message', (data, binary) => this.#receive(data, binary));
    ws.on('close', code => this.#finish(code));
    ws.on('error', error => this.#log.debug('client socket failed', { code: 'ALP_GATEWAY_CLIENT_SOCKET', error }));
    ws.on('pong', () => { this.#alive = true; });
    this.#timers.push(setTimeout(() => { if (!this.#helloed) this.close(CLOSE_CODE.handshakeTimeout, 'daemon.hello is required'); }, limits.handshakeMs));
    this.#ready = connectUpstream().then(upstream => this.#attachUpstream(upstream), error => {
      this.#upstreamGone = true;
      this.#log.warn('could not connect to alpd for a client', { code: 'ALP_GATEWAY_DAEMON_UNAVAILABLE', error });
      this.close(CLOSE_CODE.daemonUnavailable, 'alpd is unavailable');
      throw error;
    });
    this.#ready.catch(() => {});
  }

  get closed() { return this.#closed; }

  /** @param {Upstream} upstream */
  #attachUpstream({ client, hello }) {
    if (this.#closed) { client.close(); return; }
    this.#up = client;
    this.#daemonHello = hello;
    const listed = Array.isArray(hello.capabilities) ? hello.capabilities : [];
    this.#capabilities = FORWARDED_CAPABILITIES.filter(capability => listed.includes(capability));
    client.onEvent(envelope => this.#event(envelope));
    client.onClose(error => this.#upstreamClosed(error));
  }

  /** Pings the client; one that did not answer the previous ping is dropped. */
  heartbeat() {
    if (this.#closed) return;
    if (!this.#alive) { this.#log.info('closed a client that stopped answering pings', { code: 'ALP_GATEWAY_CLIENT_DEAD' }); this.#ws.terminate(); return; }
    this.#alive = false;
    try { this.#ws.ping(); } catch {}
  }

  /**
   * Ends the connection with `code`; queued frames go first. A client that does not read is
   * terminated after the grace period.
   * @param {number} code @param {string} reason
   */
  close(code, reason) {
    if (this.#closed) return;
    this.#closed = true;
    this.#pump();
    try { this.#ws.close(code, reason); } catch { this.#ws.terminate(); }
    const grace = setTimeout(() => this.#ws.terminate(), this.#limits.closeGraceMs);
    grace.unref?.();
    this.#teardown(code);
  }

  /** @param {number} code */
  #finish(code) {
    if (!this.#closed) {
      this.#closed = true;
      this.#teardown(code);
    }
  }

  /** @param {number} code */
  #teardown(code) {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers = [];
    this.#queue = [];
    this.#queuedBytes = 0;
    this.#sessions.clear();
    // alpd detaches this connection's trees as for any viewer that leaves; it cancels nothing.
    this.#up?.close();
    this.#onClosed(this, code);
  }

  /** @param {Error} error */
  #upstreamClosed(error) {
    if (this.#closed) return;
    this.#upstreamGone = true;
    this.#log.warn('the connection to alpd ended', { code: 'ALP_GATEWAY_DAEMON_DISCONNECTED', error });
    // Requests still waiting are answered as failed with an unknown outcome first (their promises
    // reject in this tick), then the client is told to reconnect.
    setImmediate(() => this.close(CLOSE_CODE.daemonUnavailable, 'alpd connection lost'));
  }

  // ---- outbound: one ordered, bounded queue for responses and events ----

  /** @param {string} frame */
  #push(frame) {
    if (this.#closed) return;
    this.#queue.push({ frame });
    this.#queuedBytes += frame.length;
    this.#pump();
  }

  /** A place in the queue whose frame is decided later (an event whose scope is being checked). */
  #slot() {
    /** @type {{ frame: string | null | undefined }} */
    const entry = { frame: undefined };
    this.#queue.push(entry);
    return (/** @type {string | null} */ frame) => {
      entry.frame = frame;
      if (frame) this.#queuedBytes += frame.length;
      this.#pump();
    };
  }

  #pump() {
    while (this.#queue.length && this.#queue[0].frame !== undefined) {
      const { frame } = /** @type {{ frame: string | null }} */ (this.#queue.shift());
      if (frame === null) continue;
      this.#queuedBytes -= frame.length;
      if (this.#ws.readyState !== 1) continue;
      if (this.#ws.bufferedAmount > this.#limits.maxBufferedBytes) return this.#slow();
      this.#ws.send(frame);
    }
    if (this.#queue.length > this.#limits.maxQueue || this.#queuedBytes > this.#limits.maxBufferedBytes) this.#slow();
  }

  #slow() {
    if (this.#closed) return;
    this.#log.warn('closed a client that did not read its messages', { code: 'ALP_GATEWAY_SLOW_CONSUMER', buffered: this.#ws.bufferedAmount, queued: this.#queue.length });
    this.#queue = [];
    this.#queuedBytes = 0;
    this.close(CLOSE_CODE.slowConsumer, 'client too slow; reconnect and replay from your cursor');
  }

  /** @param {unknown} id @param {Record<string, unknown>} body */
  #respond(id, body) {
    this.#push(JSON.stringify({ jsonrpc: '2.0', id: validId(id) ? id : null, ...body }));
  }

  // ---- inbound ----

  /** @param {import('ws').RawData} data @param {boolean} binary */
  #receive(data, binary) {
    if (this.#closed) return;
    if (binary) return this.close(CLOSE_CODE.unsupportedData, 'binary messages are not ALP frames');
    const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(/** @type {any} */ (data)).toString('utf8');
    let message;
    try { message = JSON.parse(text); } catch {
      this.#respond(null, { error: { code: RPC_ERROR.parseError, message: 'Parse error' } });
      return;
    }
    if (Array.isArray(message)) return this.#respond(null, { error: { code: RPC_ERROR.invalidRequest, message: 'Batch requests are not supported', data: { reason: 'batch_unsupported' } } });
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') return this.#respond(null, { error: { code: RPC_ERROR.invalidRequest, message: 'Invalid request' } });
    // A response: the gateway sends remote clients no requests, so it answers nothing.
    if (!Object.hasOwn(message, 'method')) return;
    const { id, method, params } = message;
    if (typeof method !== 'string') return this.#respond(null, { error: { code: RPC_ERROR.invalidRequest, message: 'Invalid request' } });
    // v1 has no notifications to the daemon: dropped unrun, never answered.
    if (id === undefined) return;
    if (!validId(id)) return this.#respond(null, { error: { code: RPC_ERROR.invalidRequest, message: 'A request id must be a string of at most 128 characters or a safe integer', data: { reason: 'invalid_id' } } });
    if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) {
      return this.#respond(id, { error: { code: RPC_ERROR.invalidParams, message: 'params must be an object', data: { reason: 'invalid_params' } } });
    }
    if (!this.#take()) {
      // Refusals in a row: a client that slows down when told starts again from zero.
      if (++this.#strikes > this.#limits.maxStrikes) return this.close(CLOSE_CODE.rateLimited, 'too many requests');
      return this.#respond(id, { error: { code: GATEWAY_ERROR.unavailable, message: 'Too many requests; slow down', data: { reason: GATEWAY_REASON.rateLimited } } });
    }
    this.#strikes = 0;
    if (this.#pending >= this.#limits.maxPending) {
      return this.#respond(id, { error: { code: GATEWAY_ERROR.unavailable, message: `Too many requests waiting for an answer (${this.#limits.maxPending})`, data: { reason: GATEWAY_REASON.tooManyPending } } });
    }
    this.#pending++;
    const started = Date.now();
    this.#handle(method, params ?? {}).then(
      result => this.#respond(id, { result }),
      error => this.#respond(id, { error: this.#errorOf(error, method) }),
    ).finally(() => {
      this.#pending--;
      this.#log.debug('request', { method, ms: Date.now() - started });
    });
  }

  /** A token of the rate limit, refilled continuously. */
  #take() {
    const now = Date.now();
    this.#tokens = Math.min(this.#limits.burst, this.#tokens + (now - this.#lastRefill) * this.#limits.rate / 1000);
    this.#lastRefill = now;
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }

  /** The wire error for a failure: alpd's errors pass unchanged; the client SDK's become an unknown outcome. @param {any} error @param {string} method */
  #errorOf(error, method) {
    if (error instanceof GatewayError) return { code: error.code, message: error.message, ...(error.data ? { data: error.data } : {}) };
    if (isAlpClientError(error)) {
      // Refused before it left the gateway: alpd never saw it, so sending it again is safe.
      if (error.reason === 'send_failed' || error.reason === 'overloaded') return { code: GATEWAY_ERROR.unavailable, message: `${method} was not sent to alpd; try again`, data: { reason: GATEWAY_REASON.notSent } };
      if (error.reason === 'timeout') return { code: ERROR.failed, message: `alpd did not answer ${method} within ${this.#limits.requestTimeoutMs} ms; it may still complete. Read the state before trying again.`, data: { reason: GATEWAY_REASON.gatewayTimeout } };
      return { code: ERROR.failed, message: `The connection to alpd ended before ${method} was answered; it may have run. Read the state before trying again.`, data: { reason: GATEWAY_REASON.daemonDisconnected } };
    }
    if (error && typeof error.code === 'number') return { code: error.code, message: String(error.message ?? 'Request failed'), ...(error.data !== undefined ? { data: error.data } : {}) };
    this.#log.error(`${method} failed in the gateway`, { code: 'ALP_GATEWAY_INTERNAL', method, error });
    return { code: ERROR.failed, message: `${method} failed in the gateway` };
  }

  /** @param {string} method @param {Record<string, any>} params */
  async #handle(method, params) {
    if (method === 'daemon.hello') {
      const greeting = this.#hello(params);
      this.#helloing = greeting.catch(() => {});
      return greeting;
    }
    if (!this.#helloed && this.#helloing) await this.#helloing;
    if (!this.#helloed) throw new GatewayError(ERROR.protocol, 'daemon.hello is required first', { reason: 'hello_required' });
    const exposure = exposureOf(method);
    if (!exposure) throw new GatewayError(RPC_ERROR.methodNotFound, `Unknown method '${method}'`);
    if (exposure.status !== 'exposed' || !exposure.permission) throw new GatewayError(RPC_ERROR.methodNotFound, `${method} is not available through the gateway`, { reason: GATEWAY_REASON.notExposed });
    const issues = validateParams(method, params);
    if (issues?.length) throw new GatewayError(RPC_ERROR.invalidParams, `Invalid params: ${issues.map(issue => `${issue.path || 'params'} ${issue.message}`).join('; ')}`, { reason: 'invalid_params', issues });
    if (!this.#grant.permissions.has(exposure.permission)) throw forbidden(`This credential lacks ${exposure.permission}`, GATEWAY_REASON.grant, { permission: exposure.permission });
    const handler = Object.hasOwn(this.#handlers, method) ? this.#handlers[method] : undefined;
    if (!handler) throw new GatewayError(RPC_ERROR.methodNotFound, `${method} is not available through the gateway`, { reason: GATEWAY_REASON.notExposed });
    return handler(pick(params, exposure.params ?? []));
  }

  /** The gateway's own handshake, answered once its handshake with alpd is done. @param {Record<string, any>} params */
  async #hello(params) {
    if (params.protocolVersion !== PROTOCOL_VERSION) throw new GatewayError(ERROR.protocol, `The gateway speaks ALP protocol ${PROTOCOL_VERSION}`, { reason: 'protocol_version', supported: [PROTOCOL_VERSION] });
    const issues = validateParams('daemon.hello', params);
    if (issues?.length) throw new GatewayError(RPC_ERROR.invalidParams, `Invalid params: ${issues.map(issue => `${issue.path || 'params'} ${issue.message}`).join('; ')}`, { reason: 'invalid_params', issues });
    await this.#ready.catch(() => { throw new GatewayError(GATEWAY_ERROR.unavailable, 'alpd is unavailable', { reason: GATEWAY_REASON.daemonDisconnected }); });
    this.#helloed = true;
    return {
      protocolVersion: PROTOCOL_VERSION,
      ...(typeof this.#daemonHello.daemonVersion === 'string' ? { daemonVersion: this.#daemonHello.daemonVersion } : {}),
      capabilities: [...this.#capabilities],
    };
  }

  /** One request to alpd on this client's connection. @param {string} method @param {Record<string, unknown>} params */
  #call(method, params) {
    if (!this.#up || this.#upstreamGone) return Promise.reject(new GatewayError(ERROR.failed, 'The connection to alpd ended', { reason: GATEWAY_REASON.daemonDisconnected }));
    return this.#up.request(method, params, { timeoutMs: this.#limits.requestTimeoutMs });
  }

  // ---- scope ----

  /** @param {string} id @param {Scoped} scoped */
  #remember(id, scoped) {
    if (this.#sessions.size >= MAX_CACHED) this.#sessions.clear();
    this.#sessions.set(id, scoped);
  }

  /**
   * The tree of a session the grant covers: the session and every ancestor up to its root lie in
   * a granted workspace. Anything else is "no such session", as for an id that never existed.
   * @param {string} sessionId @param {{ fresh?: boolean }} [options]
   * @returns {Promise<Scoped>}
   */
  async #resolve(sessionId, { fresh = false } = {}) {
    const cached = this.#sessions.get(sessionId);
    if (cached && !fresh) return cached;
    return (await this.#walk(sessionId, { trustAncestors: true })).scoped;
  }

  /**
   * Looks `sessionId` up in alpd and walks to its root, checking each session's workspace. With
   * `trustAncestors`, an ancestor already in scope ends the walk; without it every session up to
   * the root is asked for afresh, as mode checks need.
   * @param {string} sessionId @param {{ trustAncestors: boolean }} options
   * @returns {Promise<{ scoped: Scoped, chain: Array<{ id: string, projectRoot: string, mode?: string }> }>}
   */
  async #walk(sessionId, { trustAncestors }) {
    /** @type {Array<{ id: string, projectRoot: string, mode?: string }>} */
    const chain = [];
    let id = sessionId;
    let root;
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      const known = depth > 0 && trustAncestors ? this.#sessions.get(id) : undefined;
      if (known) { root = known.root; break; }
      let summary;
      try {
        ({ session: summary } = await this.#call('session.get', { sessionId: id }));
      } catch (error) {
        if (/** @type {any} */ (error)?.code === ERROR.notFound) throw new NotInScope(sessionId, depth === 0 ? 'missing' : 'outside');
        throw error;
      }
      if (!summary || typeof summary.projectRoot !== 'string' || !workspaceOf(this.#grant, summary.projectRoot)) throw new NotInScope(sessionId, 'outside');
      chain.push({ id: summary.id ?? id, projectRoot: summary.projectRoot, mode: summary.mode });
      if (typeof summary.parentId !== 'string') { root = summary.id ?? id; break; }
      id = summary.parentId;
    }
    if (root === undefined) throw new NotInScope(sessionId, 'outside');
    for (const entry of chain) this.#remember(entry.id, { root, projectRoot: entry.projectRoot, mode: entry.mode });
    return { scoped: /** @type {Scoped} */ (this.#sessions.get(sessionId) ?? { root, projectRoot: chain[0].projectRoot, mode: chain[0].mode }), chain };
  }

  /**
   * A session this client may drive (docs/alp/remote-gateway.md §5.5): in scope, and for a grant
   * with `modes`, every session from it up to its root runs in one of them, looked up afresh. A
   * prompt, a message or an answer starts or continues work in the session, and whatever reaches
   * an assignment is passed on to its requester, which may then go on in its own mode; the runtime
   * keeps an assignment's mode within its requester's, so the root's is the widest of the tree.
   * With `stop`, the session itself may run in any mode: stopping it starts nothing there, but its
   * requesters are told, so they must be within the grant. A root may always be stopped.
   * @param {string} sessionId @param {{ stop?: boolean }} [options]
   * @returns {Promise<Scoped>}
   */
  async #drive(sessionId, { stop = false } = {}) {
    if (!this.#grant.modes) return this.#resolve(sessionId);
    const { scoped, chain } = await this.#walk(sessionId, { trustAncestors: false });
    for (const entry of stop ? chain.slice(1) : chain) this.#checkMode(entry.mode, entry.id);
    return scoped;
  }

  /** A whole-tree answer that is not the tree the scope check covered. @param {string} sessionId @param {string} method */
  #outOfTree(sessionId, method) {
    this.#log.error(`${method} answered a tree beyond the session checked; refused it`, { code: 'ALP_GATEWAY_TREE_OUT_OF_SCOPE' });
    return new NotInScope(sessionId, 'outside');
  }

  /** A projectRoot param must name a granted workspace exactly. @param {unknown} projectRoot */
  #workspace(projectRoot) {
    const workspace = workspaceOf(this.#grant, projectRoot);
    if (!workspace) throw forbidden('projectRoot is not a workspace this credential may use', GATEWAY_REASON.outsideWorkspace);
    return workspace;
  }

  /** A projectRoot the gateway requires where alpd would fall back to host-level data. @param {unknown} projectRoot @param {string} method */
  #project(projectRoot, method) {
    if (projectRoot === undefined) throw forbidden(`${method} through the gateway needs a projectRoot this credential may use`, GATEWAY_REASON.hostScope);
    return this.#workspace(projectRoot);
  }

  /** @param {unknown} mode @param {string} [sessionId] the session that runs in it, when the refusal is about one */
  #checkMode(mode, sessionId) {
    const modes = this.#grant.modes;
    if (!modes || (typeof mode === 'string' && modes.has(mode))) return;
    const runs = sessionId === undefined ? '' : `Session ${sessionId} runs ${typeof mode === 'string' ? mode : 'in an unknown mode'}; `;
    throw forbidden(`${runs}this credential may use the modes ${[...modes].join(', ')}`, GATEWAY_REASON.mode, { modes: [...modes], ...(sessionId === undefined ? {} : { sessionId }) });
  }

  /**
   * A remote spec: allow-listed fields only, and cwd one of the grant's workspaces, sent to alpd
   * as its canonical path. Fields that run code or choose paths (env, mcpServers, workdir,
   * writeRoot, copy, restore, ...) are refused, not dropped, so the client knows.
   * @param {Record<string, unknown>} spec
   * @returns {{ workspace: import('./credentials.js').Workspace, spec: Record<string, any> }}
   */
  #spec(spec) {
    for (const field of Object.keys(spec)) {
      if (spec[field] !== undefined && !SPEC_FIELDS.includes(field)) throw forbidden(`spec.${field} cannot be set through the gateway`, GATEWAY_REASON.specField, { field });
    }
    const workspace = this.#workspace(spec.cwd);
    // Names, not paths: alpd checks them too; the gateway refuses anything that could be a path.
    for (const field of ['agent', 'mode', 'thinking', 'workflow']) {
      const value = spec[field];
      if (value !== undefined && (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/.test(value) || value.includes('..'))) throw forbidden(`spec.${field} must be a plain name`, GATEWAY_REASON.specField, { field });
    }
    // A model id has its own grammar: an ACP model is acp:<provider>/<model>.
    if (spec.model !== undefined && !isModelId(spec.model)) throw forbidden('spec.model must be a model id such as codex:<model> or acp:<provider>/<model>, as library.models lists them', GATEWAY_REASON.specField, { field: 'model' });
    if (this.#grant.modes) {
      if (spec.mode === undefined) throw forbidden('This credential must choose spec.mode', GATEWAY_REASON.mode, { modes: [...this.#grant.modes] });
      this.#checkMode(spec.mode);
    }
    return { workspace, spec: { ...pick(spec, SPEC_FIELDS), cwd: workspace.canonical } };
  }

  /**
   * Whether a listed session's tree lies in the grant, using the list itself for its ancestors.
   * @param {any} summary @param {Map<string, any>} listed
   */
  async #listedInScope(summary, listed) {
    let current = summary;
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      if (!current || typeof current.projectRoot !== 'string' || !workspaceOf(this.#grant, current.projectRoot)) return false;
      if (typeof current.parentId !== 'string') return true;
      const parent = listed.get(current.parentId);
      if (!parent) return this.#resolve(current.parentId).then(() => true, () => false);
      current = parent;
    }
    return false;
  }

  /** @param {import('@anhlp/alp-protocol').Envelope} envelope */
  #event(envelope) {
    if (this.#closed) return;
    const id = envelope?.sessionId;
    if (typeof id !== 'string') return;
    const frame = JSON.stringify({ jsonrpc: '2.0', method: 'event', params: envelope });
    const event = /** @type {any} */ (envelope.event);
    const known = this.#sessions.get(id);
    if (known) { if (this.#wanted(envelope, known)) this.#push(frame); return; }
    // A child opening in a tree already in scope.
    const parent = event?.type === 'session.opened' && typeof event.session?.parentId === 'string' ? this.#sessions.get(event.session.parentId) : undefined;
    if (parent && workspaceOf(this.#grant, event.session.projectRoot)) {
      this.#remember(id, { root: parent.root, projectRoot: event.session.projectRoot, mode: event.session.mode });
      return this.#push(frame);
    }
    // question.watch brings every tree's questions (and roots' turn ends, with turns): a session
    // found outside the grant once is not looked up again (a session's workspace and tree never
    // change), and is not worth a warning.
    const copy = WATCHED.has(event?.type) && envelope.cursor === undefined;
    if (copy && this.#outside.has(id)) return;
    // Otherwise the session is looked up before the event, or anything after it, goes out.
    const fill = this.#slot();
    this.#resolve(id).then(scoped => fill(this.#wanted(envelope, scoped) ? frame : null), error => {
      fill(null);
      if (error instanceof NotInScope && copy && error.why === 'outside') {
        if (this.#outside.size >= MAX_CACHED) this.#outside.clear();
        this.#outside.add(id);
        this.#log.debug('dropped a question of a session outside the grant', { code: 'ALP_GATEWAY_EVENT_OUT_OF_SCOPE' });
      } else if (error instanceof NotInScope && copy) this.#log.debug('dropped a question of a session not found', { code: 'ALP_GATEWAY_EVENT_OUT_OF_SCOPE' });
      else if (error instanceof NotInScope) this.#log.warn('dropped an event of a session outside the grant', { code: 'ALP_GATEWAY_EVENT_OUT_OF_SCOPE' });
      else if (!this.#upstreamGone) this.close(CLOSE_CODE.internal, 'could not check an event; reconnect and replay from your cursor');
    });
  }

  /**
   * Whether an in-scope event goes out. A question or turn end a watch announced (no cursor, from a
   * tree this client did not attach) goes out only for the workspace the watch named: alpd is asked
   * for every tree, as it compares projectRoot strings and a workspace has two
   * (docs/alp/remote-gateway.md §5.1).
   * @param {import('@anhlp/alp-protocol').Envelope} envelope @param {Scoped} scoped
   */
  #wanted(envelope, scoped) {
    const type = /** @type {any} */ (envelope.event)?.type;
    if (!WATCHED.has(type) || envelope.cursor !== undefined || this.#attached.has(scoped.root)) return true;
    if (this.#watch === undefined) return false;
    // The tree's workspace, as alpd's watch compares it: its root's.
    const project = this.#sessions.get(scoped.root)?.projectRoot ?? scoped.projectRoot;
    return this.#watch === null || project === this.#watch.path || project === this.#watch.canonical;
  }

  /**
   * session.list pages: alpd's are read with what is left of the limit until the page is full or
   * alpd has no more, so a page the grant thins out still continues from alpd's own cursor.
   * @param {Record<string, any>} params @param {(session: any, listed: Map<string, any>) => Promise<boolean>} keep
   */
  async #listPages(params, keep) {
    const limit = params.limit;
    /** @type {any[]} */ const kept = [];
    let result;
    let cursor = params.cursor;
    for (let reads = 0; reads < MAX_LIST_READS; reads++) {
      result = await this.#call('session.list', { ...params, ...(limit === undefined ? {} : { limit: limit - kept.length }), ...(cursor === undefined ? {} : { cursor }) });
      const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
      const listed = new Map(sessions.map((/** @type {any} */ session) => [session.id, session]));
      for (const session of sessions) if (await keep(session, listed)) kept.push(session);
      cursor = typeof result?.nextCursor === 'string' ? result.nextCursor : undefined;
      if (limit === undefined || cursor === undefined || kept.length >= limit) break;
    }
    const { nextCursor: _next, ...rest } = result ?? {};
    return { ...rest, sessions: kept, ...(cursor === undefined ? {} : { nextCursor: cursor }) };
  }

  // ---- handlers of exposed methods: params are already schema-checked and allow-listed ----

  /** @type {Record<string, (params: Record<string, any>) => Promise<unknown>>} */
  #handlers = {
    'catalog.get': () => this.#call('catalog.get', {}),

    'session.list': async params => {
      const only = params.projectRoot === undefined ? undefined : this.#workspace(params.projectRoot);
      const { projectRoot: _projectRoot, cursor: sealed, ...rest } = params;
      let cursor;
      if (sealed !== undefined) {
        cursor = openCursor(sealed, this.#grant.id);
        if (cursor === undefined) throw new GatewayError(RPC_ERROR.invalidParams, 'cursor is not one this gateway answered; read the list again from the start', { reason: 'invalid_params' });
      }
      const keep = async (/** @type {any} */ session, /** @type {Map<string, any>} */ listed) => {
        if (only && session.projectRoot !== only.path && session.projectRoot !== only.canonical) return false;
        return this.#listedInScope(session, listed);
      };
      // alpd pages and searches the granted workspaces only (as path and canonical path), so its
      // pages, cursors and matches never cover another one; the rows are still checked one by one.
      const roots = [...new Set((only ? [only] : this.#grant.workspaces).flatMap(workspace => [workspace.path, workspace.canonical]))];
      if (roots.length > MAX_LIST_PROJECTS) {
        // Too many to name: the whole list, unpaged, searched here, as before session.list.page.
        const { limit: _limit, query, ...whole } = rest;
        const words = typeof query === 'string' ? query.toLowerCase().split(/\s+/).filter(Boolean) : [];
        return this.#listPages(whole, async (session, listed) => (await keep(session, listed)) && words.every(word => `${session.title ?? ''}\n${session.id}`.toLowerCase().includes(word)));
      }
      const result = await this.#listPages({ ...rest, ...(cursor === undefined ? {} : { cursor }), projectRoots: roots }, keep);
      return typeof result.nextCursor === 'string' ? { ...result, nextCursor: sealCursor(result.nextCursor, this.#grant.id) } : result;
    },

    'session.get': async params => { await this.#resolve(params.sessionId); return this.#call('session.get', params); },
    // A tree has one workspace: alpd opens assignments and the supervisor with their requester's
    // projectRoot. A whole-tree answer is checked against it anyway, and refused if it spans more.
    'session.status': async params => {
      const scoped = await this.#resolve(params.sessionId);
      const result = await this.#call('session.status', params);
      const status = result?.status;
      const sessions = Array.isArray(status?.sessions) ? status.sessions : [];
      if (status?.rootId !== scoped.root || sessions.some((/** @type {any} */ session) => !workspaceOf(this.#grant, session?.projectRoot))) throw this.#outOfTree(params.sessionId, 'session.status');
      return result;
    },
    // The run log of the session's root: entries name no workspace, so the root is the check.
    'session.log': async params => {
      const scoped = await this.#resolve(params.sessionId);
      const result = await this.#call('session.log', params);
      if (result?.rootId !== scoped.root) throw this.#outOfTree(params.sessionId, 'session.log');
      return result;
    },
    'session.release': async params => {
      const scoped = await this.#resolve(params.sessionId);
      const result = await this.#call('session.release', params);
      this.#attached.delete(scoped.root);
      return result;
    },

    'session.attach': async params => {
      const scoped = await this.#resolve(params.sessionId);
      // Before the call: the questions it announces come before its answer.
      const before = this.#attached.has(scoped.root);
      this.#attached.add(scoped.root);
      try { return await this.#call('session.attach', params); }
      catch (error) { if (!before) this.#attached.delete(scoped.root); throw error; }
    },

    'session.preview': async params => this.#call('session.preview', { spec: this.#spec(params.spec).spec }),

    'session.create': async params => {
      const { workspace, spec } = this.#spec(params.spec);
      let sessionId = params.sessionId;
      let generated = false;
      if (sessionId !== undefined) {
        try {
          const existing = await this.#resolve(sessionId, { fresh: true });
          if (this.#grant.modes && spec.mode === undefined) this.#checkMode(existing.mode);
        } catch (error) {
          if (!(error instanceof NotInScope)) throw error;
          if (error.why === 'outside') throw forbidden(`Session ${sessionId} is not in a workspace this credential may use`, GATEWAY_REASON.outsideWorkspace);
        }
      } else {
        // The gateway names a new root itself, so the events of its creation, which may come
        // before the answer, are known to be in scope.
        sessionId = `ses_${randomBytes(8).toString('hex')}`;
        generated = true;
        this.#remember(sessionId, { root: sessionId, projectRoot: workspace.canonical, mode: spec.mode });
      }
      let result;
      const before = this.#attached.has(sessionId);
      // A root resumes or is created attached; its waiting questions are announced before the answer.
      this.#attached.add(sessionId);
      try {
        result = await this.#call('session.create', { ...params, sessionId, spec });
      } catch (error) {
        if (generated) this.#sessions.delete(sessionId);
        if (!before) this.#attached.delete(sessionId);
        throw error;
      }
      const created = result?.session;
      if (!created || !workspaceOf(this.#grant, created.projectRoot) || created.parentId) {
        // Another client took this id in another workspace meanwhile: let go of it.
        this.#sessions.delete(sessionId);
        this.#attached.delete(sessionId);
        this.#log.error('session.create answered a session outside the grant; released it', { code: 'ALP_GATEWAY_CREATE_OUT_OF_SCOPE' });
        await this.#call('session.release', { sessionId }).catch(() => {});
        throw forbidden(`Session ${sessionId} is not in a workspace this credential may use`, GATEWAY_REASON.outsideWorkspace);
      }
      this.#remember(created.id, { root: created.id, projectRoot: created.projectRoot, mode: created.mode });
      return result;
    },

    'session.prompt': async params => {
      await this.#drive(params.sessionId);
      for (const part of params.content) {
        if (!CONTENT_TYPES.includes(part?.type)) throw forbidden(`Prompt content of type ${JSON.stringify(part?.type)} cannot be sent through the gateway`, GATEWAY_REASON.contentType, { allowed: [...CONTENT_TYPES] });
      }
      return this.#call('session.prompt', params);
    },

    'session.configure': async params => {
      await this.#resolve(params.sessionId);
      if (params.mode !== undefined) this.#checkMode(params.mode);
      const result = await this.#call('session.configure', params);
      const scoped = this.#sessions.get(params.sessionId);
      if (scoped && typeof result?.session?.mode === 'string') scoped.mode = result.session.mode;
      return result;
    },

    'session.interrupt': async params => { await this.#drive(params.sessionId, { stop: true }); return this.#call('session.interrupt', params); },
    'session.close': async params => { await this.#drive(params.sessionId, { stop: true }); return this.#call('session.close', params); },
    'session.rename': async params => { await this.#resolve(params.sessionId); return this.#call('session.rename', params); },
    'session.archive': async params => { await this.#resolve(params.sessionId); return this.#call('session.archive', params); },
    // Mail from the user wakes or steers the session, and an assignment's is passed to its requester.
    'session.message': async params => { await this.#drive(params.sessionId); return this.#call('session.message', params); },

    'question.list': async params => {
      const only = params.projectRoot === undefined ? undefined : this.#workspace(params.projectRoot);
      const result = await this.#call('question.list', {});
      const kept = [];
      for (const question of Array.isArray(result?.questions) ? result.questions : []) {
        const scoped = await this.#resolve(question.sessionId).catch(() => undefined);
        if (!scoped || (only && scoped.projectRoot !== only.path && scoped.projectRoot !== only.canonical)) continue;
        kept.push(question);
      }
      return { ...result, questions: kept };
    },

    // alpd tells this client of every tree's questions; #event keeps those in scope, and #wanted
    // those of the workspace named. The list is question.list's, filtered the same way.
    'question.watch': async params => {
      const only = params.projectRoot === undefined ? null : this.#workspace(params.projectRoot);
      // Before the call: alpd may tell of a question before it answers.
      const previous = this.#watch;
      this.#watch = only;
      let result;
      try { result = await this.#call('question.watch', params.turns === true ? { turns: true } : {}); }
      catch (error) { this.#watch = previous; throw error; }
      const kept = [];
      for (const question of Array.isArray(result?.questions) ? result.questions : []) {
        const scoped = await this.#resolve(question.sessionId).catch(() => undefined);
        if (!scoped || (only && scoped.projectRoot !== only.path && scoped.projectRoot !== only.canonical)) continue;
        kept.push(question);
      }
      return { ...result, questions: kept };
    },

    'question.answer': async params => {
      // An exact id only: alpd accepts a unique prefix, which could match a question elsewhere.
      const { questions = [] } = await this.#call('question.list', {});
      const question = questions.find((/** @type {any} */ candidate) => candidate.id === params.questionId);
      const missing = new GatewayError(ERROR.notFound, `No question ${params.questionId} waits for an answer`);
      if (!question) throw missing;
      await this.#resolve(question.sessionId).catch(() => { throw missing; });
      // An answer, or a dismissal, lets the asking turn go on.
      await this.#drive(question.sessionId);
      return this.#call('question.answer', { ...params, questionId: question.id });
    },

    'board.list': async params => {
      this.#workspace(params.projectRoot);
      return this.#call('board.list', params);
    },

    // File names under a granted workspace, as alpd confines them (docs/protocol/alp-json-rpc-v1.md
    // §12.3). alpd is sent the canonical path; an answered path that is not plainly relative to it
    // (absolute, a drive, `.` or `..`, an empty segment, a NUL) is dropped as alpd would never give it.
    'workspace.files.search': async params => {
      const workspace = this.#workspace(params.projectRoot);
      const result = await this.#call('workspace.files.search', { ...params, projectRoot: workspace.canonical });
      const files = [];
      for (const file of Array.isArray(result?.files) ? result.files : []) {
        if (relativeFile(file?.path)) files.push({ path: file.path });
        else this.#log.error('workspace.files.search answered a path outside the workspace; dropped it', { code: 'ALP_GATEWAY_FILE_OUT_OF_SCOPE' });
      }
      return { files, ...(result?.truncated === true ? { truncated: true } : {}) };
    },

    // Project resources (docs/protocol/alp-json-rpc-v1.md §15): alpd never walks up from
    // projectRoot, so the exact string the grant lists is the whole check. Writes are recorded by
    // alpd as the user's; params carry no identity (any `by` is dropped with the other unknown params).
    'task.list': async params => { this.#workspace(params.projectRoot); return this.#call('task.list', params); },
    'task.create': async params => { this.#workspace(params.projectRoot); return this.#call('task.create', params); },
    'task.update': async params => { this.#workspace(params.projectRoot); return this.#call('task.update', params); },
    'task.gate.resolve': async params => { this.#workspace(params.projectRoot); return this.#call('task.gate.resolve', params); },
    // Without projectRoot alpd answers the host library alone: the gateway asks for a project.
    // Rows name entries; their listed fields only. A team that cannot be read says so without the
    // file and parse error alpd reports, which name host paths and quote the file.
    'team.list': async params => {
      this.#project(params.projectRoot, 'team.list');
      const result = await this.#call('team.list', params);
      const teams = (Array.isArray(result?.teams) ? result.teams : []).map((/** @type {any} */ team) => {
        const row = pick(team, TEAM_ROW_FIELDS);
        if (row.error !== undefined) row.error = 'This team cannot be read on the daemon host';
        return row;
      });
      return { ...result, teams };
    },
    'library.list': async params => {
      this.#project(params.projectRoot, 'library.list');
      const result = await this.#call('library.list', params);
      return { ...result, entries: (Array.isArray(result?.entries) ? result.entries : []).map((/** @type {any} */ entry) => pick(entry, LIBRARY_ROW_FIELDS)) };
    },
    'library.models': async () => {
      const result = await this.#call('library.models', {});
      return { ...result, models: (Array.isArray(result?.models) ? result.models : []).map((/** @type {any} */ model) => pick(model, MODEL_ROW_FIELDS)) };
    },
    'settings.language.get': () => this.#call('settings.language.get', {}),
  };

}
