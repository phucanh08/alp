import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { WebSocketServer } from 'ws';
import { ClientConnection, CLOSE_CODE } from './connection.js';
import { isLoopbackAddress } from './config.js';
import { directLoopback, ownerOptionError } from './owner.js';
import { TicketBook } from './tickets.js';
import { daemonMonitor, upstreamConnector } from './upstream.js';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import type { Logger } from '@anhlp/alp-core/log';
import type { GatewayConfig } from './config.js';
import type { CredentialStore } from './credentials.js';
import type { OwnerOption } from './owner.js';
import type { OpenTransport } from './upstream.js';

/**
 * The gateway's HTTP side (docs/alp/remote-gateway.md §3, §4, §7):
 *   GET  /healthz     liveness of the gateway process
 *   GET  /readyz      200 only while alpd answers and reports itself ready
 *   POST /v1/tickets  Authorization: Bearer <credential> → a one-time ticket
 *   GET  /v1/ws       WebSocket, subprotocols `alp.v1` and `alp.ticket.<ticket>`
 * Every route checks the Host header (no DNS rebinding) and that a non-loopback client came over
 * TLS, directly or through a trusted proxy; browser routes check the Origin.
 *
 * With `serveStatic`, a GET or HEAD for any other path goes to that hook, after the same Host and
 * TLS checks; the gateway's own paths (above, and everything under /v1/) never reach it.
 */

export const SUBPROTOCOL = 'alp.v1';
export const TICKET_PROTOCOL_PREFIX = 'alp.ticket.';
export const WEBSOCKET_PATH = '/v1/ws';
export const TICKET_PATH = '/v1/tickets';

const plain = (address: string | undefined) => (address ?? '').replace(/^::ffff:/, '');

/**
 * The path of a raw request target, or undefined when it cannot be parsed (`//[`, `//x:99999/`):
 * such a target is a 400, never an exception in the request handler.
 */
const pathOf = (request: http.IncomingMessage) => { try { return new URL(request.url ?? '/', 'http://gateway').pathname; } catch { return undefined; } };

/** Paths the gateway answers itself, whatever the method; a static hook never sees them. */
const ownPath = (pathname: string) => pathname === '/healthz' || pathname === '/readyz' || pathname === '/v1' || pathname.startsWith('/v1/');

/**
 * `serveStatic` answers GET and HEAD requests outside the gateway's own paths, once the Host and
 *   TLS checks passed. It writes the response itself; returning (or resolving to) `false` without
 * writing leaves the gateway's 404, and a throw or rejection becomes a 500.
 * `owner` (alp dashboard only; owner.ts) names the host owner's credential and the owner handlers:
 * that credential on a direct loopback socket may call the methods the matrix marks `owner`. It
 * needs a plain loopback config (no TLS, no trusted proxy), else createGateway throws.
 */
export function createGateway({ config, store, openTransport, logger, version, monitorIntervalMs, serveStatic, owner }: {
  config: GatewayConfig,
  store: CredentialStore,
  openTransport: OpenTransport,
  logger: Logger,
  version: string,
  monitorIntervalMs?: number,
  serveStatic?: (request: http.IncomingMessage, response: http.ServerResponse) => unknown,
  owner?: OwnerOption,
}) {
  const ownerProblem = ownerOptionError(owner, config);
  if (ownerProblem) throw new Error(ownerProblem);
  const { limits } = config;
  const tickets = new TicketBook({ ttlMs: limits.ticketTtlMs });
  const connections = new Set<ClientConnection>();
  /** Open and opening connections per credential. */
  const perPrincipal = new Map();
  const decrementPrincipal = (id: string) => {
    const next = (perPrincipal.get(id) ?? 1) - 1;
    if (next <= 0) perPrincipal.delete(id);
    else perPrincipal.set(id, next);
  };
  let opening = 0;
  const failures = new Map<string, { count: number, resetAt: number }>();
  const connectUpstream = upstreamConnector({ openTransport, version, maxPending: limits.maxPending });
  let monitor: ReturnType<typeof daemonMonitor> | undefined;
  const timers: Array<ReturnType<typeof setInterval>> = [];
  let hosts = new Set<string>();
  let closing = false;

  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxFrame, perMessageDeflate: false, clientTracking: false, handleProtocols: () => SUBPROTOCOL });

  /** The client's address and how it reached the gateway; forwarded headers count only from a trusted proxy. */
  function peerOf(request: http.IncomingMessage): { ip: string, proxied: boolean, secure: boolean, host?: string | undefined } {
    const remote = plain(request.socket.remoteAddress);
    const forwarded = request.headers['x-forwarded-for'];
    if (!config.trustProxy.has(remote) || typeof forwarded !== 'string') return { ip: remote, proxied: false, secure: !!config.tls };
    const chain = forwarded.split(',').map(entry => plain(entry.trim())).filter(Boolean);
    let ip = remote;
    while (chain.length) { ip = chain.pop() as string; if (!config.trustProxy.has(ip)) break; }
    const proto = String(request.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase();
    const forwardedHost = request.headers['x-forwarded-host'];
    return { ip, proxied: true, secure: proto === 'https', host: typeof forwardedHost === 'string' ? forwardedHost.split(',')[0].trim() : undefined };
  }

  /**
   * Why a request may not go on, or undefined: an unknown Host, or plaintext from beyond loopback.
   */
  function refusal(request: http.IncomingMessage, peer: ReturnType<typeof peerOf>) {
    const host = String(peer.host ?? request.headers.host ?? '').toLowerCase();
    if (!hosts.has(host)) return { status: 421, error: 'unknown_host' };
    if (peer.secure || config.allowInsecure) return undefined;
    if (!peer.proxied && isLoopbackAddress(request.socket.remoteAddress)) return undefined;
    return { status: 403, error: 'tls_required' };
  }

  /** The request's Origin when allowed (null without one), or false. */
  function originOf(request: http.IncomingMessage) {
    const origin = request.headers.origin;
    if (origin === undefined) return null;
    const normalized = String(origin).toLowerCase();
    return config.origins.has(normalized) ? normalized : false;
  }

  function blocked(ip: string) {
    const entry = failures.get(ip);
    if (!entry || entry.resetAt <= Date.now()) { failures.delete(ip); return undefined; }
    return entry.count >= limits.authFailures ? Math.ceil((entry.resetAt - Date.now()) / 1000) : undefined;
  }

  function failed(ip: string, reason: string) {
    const now = Date.now();
    const entry = failures.get(ip);
    if (!entry || entry.resetAt <= now) failures.set(ip, { count: 1, resetAt: now + limits.authWindowMs });
    else entry.count++;
    if (failures.size > 10_000) for (const [key, value] of failures) if (value.resetAt <= now) failures.delete(key);
    logger.warn('refused an authentication', { code: 'ALP_GATEWAY_AUTH_FAILED', ip, reason });
  }

  function json(response: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    const text = JSON.stringify(body);
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-length': String(Buffer.byteLength(text)), ...headers });
    response.end(text);
  }

  /** CORS for an allowed browser origin; nothing for clients without one. */
  const cors = (origin: string | null): Record<string, string> => origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};

  /** Hands a request to the static hook; its `false` or failure ends in a 404 or 500. */
  async function staticRoute(hook: NonNullable<typeof serveStatic>, request: http.IncomingMessage, response: http.ServerResponse) {
    try {
      const handled = await hook(request, response);
      if (handled === false && !response.headersSent && !response.writableEnded) json(response, 404, { error: 'not_found' });
    } catch (error) {
      logger.error('the static file hook failed', { code: 'ALP_GATEWAY_STATIC_FAILED', error });
      if (!response.headersSent) json(response, 500, { error: 'internal' });
      else response.destroy();
    }
  }

  function onRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    const peer = peerOf(request);
    const refused = refusal(request, peer);
    if (refused) return json(response, refused.status, { error: refused.error });
    const pathname = pathOf(request);
    if (pathname === undefined) return json(response, 400, { error: 'bad_request' });
    if (serveStatic && !ownPath(pathname) && (request.method === 'GET' || request.method === 'HEAD')) return void staticRoute(serveStatic, request, response);
    if (pathname === '/healthz' && request.method === 'GET') return json(response, 200, { live: true });
    if (pathname === '/readyz' && request.method === 'GET') {
      const state = monitor?.state ?? { connected: false, ready: false, code: 'ALP_GATEWAY_STARTING' };
      return json(response, state.ready && !closing ? 200 : 503, { ready: state.ready && !closing, checks: [{ id: 'daemon', ok: state.ready, ...(state.code ? { code: state.code } : {}) }] });
    }
    if (pathname !== TICKET_PATH) return json(response, 404, { error: 'not_found' });
    const origin = originOf(request);
    if (origin === false) return json(response, 403, { error: 'origin_not_allowed' });
    if (request.method === 'OPTIONS') {
      response.writeHead(204, { ...cors(origin), 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'authorization, content-type', 'access-control-max-age': '600', 'cache-control': 'no-store' });
      return response.end();
    }
    if (request.method !== 'POST') return json(response, 405, { error: 'method_not_allowed' }, { allow: 'POST, OPTIONS', ...cors(origin) });
    if (Number(request.headers['content-length'] ?? 0) > 1024) return json(response, 413, { error: 'body_too_large' }, cors(origin));
    request.resume();
    const wait = blocked(peer.ip);
    if (wait !== undefined) return json(response, 429, { error: 'too_many_failures' }, { 'retry-after': String(wait), ...cors(origin) });
    const header = request.headers.authorization;
    const token = typeof header === 'string' && /^Bearer [^\s]+$/.test(header) ? header.slice(7) : undefined;
    const grant = token ? store.verify(token) : undefined;
    if (!grant) {
      failed(peer.ip, token ? 'credential' : 'missing');
      return json(response, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer realm="alp-gateway"', ...cors(origin) });
    }
    const issued = tickets.issue(grant.id, origin);
    if (!issued) return json(response, 429, { error: 'too_many_tickets' }, cors(origin));
    logger.info('issued a ticket', { code: 'ALP_GATEWAY_TICKET', principal: grant.id, ip: peer.ip });
    json(response, 201, {
      ticket: issued.ticket,
      expiresAt: new Date(issued.expiresAt).toISOString(),
      websocket: WEBSOCKET_PATH,
      subprotocols: [SUBPROTOCOL, `${TICKET_PROTOCOL_PREFIX}${issued.ticket}`],
      principal: {
        id: grant.id,
        label: grant.label,
        permissions: [...grant.permissions],
        workspaces: grant.workspaces.map(workspace => workspace.path),
        // The same workspaces with the path alpd names them by (realpath on the host), as session
        // summaries carry it in projectRoot.
        workspaceRoots: grant.workspaces.map(workspace => ({ path: workspace.path, canonical: workspace.canonical })),
        ...(grant.modes ? { modes: [...grant.modes] } : {}),
      },
    }, cors(origin));
  }

  function onUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer) {
    socket.on('error', () => {});
    const refuse = (status: number, text: string, reason?: string) => {
      if (reason) logger.info('refused a WebSocket', { code: 'ALP_GATEWAY_UPGRADE_REFUSED', status, reason });
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`);
    };
    if (closing) return refuse(503, 'Service Unavailable');
    const peer = peerOf(request);
    const refused = refusal(request, peer);
    if (refused) return refuse(refused.status, refused.status === 421 ? 'Misdirected Request' : 'Forbidden', refused.error);
    const pathname = pathOf(request);
    if (pathname === undefined) return refuse(400, 'Bad Request', 'request_target');
    if (pathname !== WEBSOCKET_PATH) return refuse(404, 'Not Found');
    const origin = originOf(request);
    if (origin === false) return refuse(403, 'Forbidden', 'origin_not_allowed');
    const offered = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map(entry => entry.trim()).filter(Boolean);
    if (!offered.includes(SUBPROTOCOL)) return refuse(400, 'Bad Request', 'subprotocol');
    if (blocked(peer.ip) !== undefined) return refuse(429, 'Too Many Requests', 'too_many_failures');
    const presented = offered.filter(entry => entry.startsWith(TICKET_PROTOCOL_PREFIX));
    const principal = presented.length === 1 ? tickets.consume(presented[0].slice(TICKET_PROTOCOL_PREFIX.length), origin) : undefined;
    const grant = principal ? store.grant(principal) : undefined;
    if (!grant) { failed(peer.ip, 'ticket'); return refuse(401, 'Unauthorized'); }
    if (connections.size + opening >= limits.maxConnections) return refuse(503, 'Service Unavailable', 'max_connections');
    if ((perPrincipal.get(grant.id) ?? 0) >= limits.maxConnectionsPerCredential) return refuse(429, 'Too Many Requests', 'max_connections_per_credential');
    opening++;
    perPrincipal.set(grant.id, (perPrincipal.get(grant.id) ?? 0) + 1);
    let settled = false;
    const release = () => { if (settled) return; settled = true; opening--; };
    socket.once('close', () => { if (!settled) { release(); decrementPrincipal(grant.id); } });
    wss.handleUpgrade(request, socket, head, ws => {
      release();
      const id = randomBytes(6).toString('hex');
      const log = logger.child({ connection: id, principal: grant.id, ip: peer.ip });
      let counted = true;
      /** Gives back this connection's place in its credential's count, once. */
      const uncount = () => {
        if (!counted) return;
        counted = false;
        decrementPrincipal(grant.id);
      };
      // Whether this socket could be the owner's is fixed at the upgrade; the credential half is
      // checked again on every request (connection.ts #isOwner), so a rotated or revoked owner
      // credential stops being the owner at once.
      const direct = !!owner && directLoopback(request, peer);
      try {
        const connection = new ClientConnection({
          ws, grant, id, connectUpstream, logger: log,
          ...(owner ? { owner: { isOwner: () => direct && owner.credentialId() === grant.id, methods: owner.methods ?? {} } } : {}),
          limits: { maxPending: limits.maxPending, rate: limits.rate, burst: limits.burst, maxStrikes: limits.maxStrikes, handshakeMs: limits.handshakeMs, requestTimeoutMs: limits.requestTimeoutMs, maxBufferedBytes: limits.maxBufferedBytes, maxQueue: limits.maxQueue, closeGraceMs: limits.closeGraceMs, maxFrame: limits.maxFrame },
          onClosed: (closed, code) => {
            connections.delete(closed);
            uncount();
            log.info('closed a connection', { code: 'ALP_GATEWAY_DISCONNECTED', closeCode: code });
          },
        });
        if (!connection.closed) connections.add(connection);
        log.info('opened a connection', { code: 'ALP_GATEWAY_CONNECTED' });
      } catch (error) {
        // A connection that cannot be set up is dropped; it never takes the gateway down.
        log.error('could not set up a connection', { code: 'ALP_GATEWAY_CONNECTION_FAILED', error });
        uncount();
        try { ws.terminate(); } catch {}
      }
    });
  }

  /**
   * The handlers as the server calls them: a throw from one is logged and answered (500, or the
   * socket closed), never left to reach the process, so one bad request cannot stop the gateway.
   */
  function guardedRequest(request: http.IncomingMessage, response: http.ServerResponse) {
    try { onRequest(request, response); }
    catch (error) {
      logger.error('a request handler failed', { code: 'ALP_GATEWAY_REQUEST_FAILED', error });
      if (!response.headersSent) { try { json(response, 500, { error: 'internal' }); return; } catch {} }
      response.destroy();
    }
  }

  function guardedUpgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer) {
    try { onUpgrade(request, socket, head); }
    catch (error) {
      logger.error('an upgrade handler failed', { code: 'ALP_GATEWAY_UPGRADE_FAILED', error });
      try { socket.end('HTTP/1.1 500 Internal Server Error\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n'); } catch { socket.destroy(); }
    }
  }

  // A revoked, rotated or expired credential loses its tickets and connections at once; a changed
  // grant closes them too, so every check runs again under the new grant.
  const unsubscribe = store.onChange(changes => {
    for (const [principal, change] of changes) {
      tickets.revoke(principal);
      for (const connection of [...connections]) {
        if (connection.principal !== principal) continue;
        if (change === 'revoked') connection.close(CLOSE_CODE.unauthorized, 'credential revoked or expired');
        else connection.close(CLOSE_CODE.grantChanged, 'credential grant changed');
      }
      logger.info(`credential ${change}; closed its connections`, { code: 'ALP_GATEWAY_CREDENTIAL_CHANGED', principal });
      // Its terminals end now too, whatever changed (§5.18): a shell never outlives the grant it was opened under.
      void monitor?.revokeTerminals(principal).then(outcome => {
        if (outcome.revoked) { if (outcome.closed) logger.info('ended the terminals of a changed credential', { code: 'ALP_GATEWAY_TERMINALS_REVOKED', principal, closed: outcome.closed }); }
        else logger.warn('could not end the terminals of a changed credential now; alpd ends them when their reconnect time runs out', { code: 'ALP_GATEWAY_TERMINALS_REVOKE_FAILED', principal });
      });
    }
  });

  let server: http.Server | https.Server | undefined;

  return {
    connections,
    tickets,
    perPrincipal,
    get monitor() { return monitor; },
    /** Loads credentials, starts watching alpd and listens; resolves with the bound address. */
    async listen() {
      await store.reload();
      server = config.tls
        ? https.createServer({ cert: await readFile(config.tls.cert), key: await readFile(config.tls.key) }, guardedRequest)
        : http.createServer(guardedRequest);
      server.headersTimeout = 10_000;
      server.requestTimeout = 15_000;
      server.on('upgrade', guardedUpgrade);
      server.on('clientError', (_error, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch {} });
      const listening = server as http.Server;
      await new Promise((resolve, reject) => {
        listening.once('error', reject);
        listening.listen(config.port, config.host, () => { listening.off('error', reject); resolve(undefined); });
      });
      const { port } = listening.address() as AddressInfo;
      hosts = new Set([...config.hosts, `127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
      if (config.tls && port === 443) for (const name of config.hosts) hosts.add(name.replace(/:443$/, ''));
      monitor = daemonMonitor({ openTransport, version, logger, ...(monitorIntervalMs ? { intervalMs: monitorIntervalMs } : {}) });
      timers.push(setInterval(() => { for (const connection of connections) connection.heartbeat(); }, limits.heartbeatMs));
      timers.push(setInterval(() => store.expire(), 15_000));
      for (const timer of timers) timer.unref?.();
      logger.info('listening', { code: 'ALP_GATEWAY_LISTENING', host: config.host, port, tls: !!config.tls });
      return { host: config.host, port, url: `${config.tls ? 'https' : 'http'}://${config.host.includes(':') ? `[${config.host}]` : config.host}:${port}` };
    },
    /** Closes every connection (1001) and stops. */
    async close() {
      closing = true;
      for (const timer of timers) clearInterval(timer);
      unsubscribe();
      monitor?.stop();
      for (const connection of [...connections]) connection.close(CLOSE_CODE.goingAway, 'gateway shutting down');
      if (server) {
        const stopping = server as http.Server;
        await new Promise(resolve => { stopping.close(() => resolve(undefined)); stopping.closeAllConnections?.(); });
      }
    },
  };
}
