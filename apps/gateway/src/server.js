// @ts-check
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { WebSocketServer } from 'ws';
import { ClientConnection, CLOSE_CODE } from './connection.js';
import { isLoopbackAddress } from './config.js';
import { TicketBook } from './tickets.js';
import { daemonMonitor, upstreamConnector } from './upstream.js';

/**
 * The gateway's HTTP side (docs/alp/remote-gateway.md §3, §4, §7):
 *   GET  /healthz     liveness of the gateway process
 *   GET  /readyz      200 only while alpd answers and reports itself ready
 *   POST /v1/tickets  Authorization: Bearer <credential> → a one-time ticket
 *   GET  /v1/ws       WebSocket, subprotocols `alp.v1` and `alp.ticket.<ticket>`
 * Every route checks the Host header (no DNS rebinding) and that a non-loopback client came over
 * TLS, directly or through a trusted proxy; browser routes check the Origin.
 */

export const SUBPROTOCOL = 'alp.v1';
export const TICKET_PROTOCOL_PREFIX = 'alp.ticket.';
export const WEBSOCKET_PATH = '/v1/ws';
export const TICKET_PATH = '/v1/tickets';

/** @param {string | undefined} address */
const plain = address => (address ?? '').replace(/^::ffff:/, '');

/**
 * @param {{
 *   config: import('./config.js').GatewayConfig,
 *   store: import('./credentials.js').CredentialStore,
 *   openTransport: import('./upstream.js').OpenTransport,
 *   logger: import('@anhlp/alp-core/log').Logger,
 *   version: string,
 *   monitorIntervalMs?: number,
 * }} options
 */
export function createGateway({ config, store, openTransport, logger, version, monitorIntervalMs }) {
  const { limits } = config;
  const tickets = new TicketBook({ ttlMs: limits.ticketTtlMs });
  /** @type {Set<ClientConnection>} */
  const connections = new Set();
  /** Open and opening connections per credential. */
  const perPrincipal = new Map();
  let opening = 0;
  /** @type {Map<string, { count: number, resetAt: number }>} */
  const failures = new Map();
  const connectUpstream = upstreamConnector({ openTransport, version, maxPending: limits.maxPending });
  /** @type {ReturnType<typeof daemonMonitor> | undefined} */
  let monitor;
  /** @type {Array<ReturnType<typeof setInterval>>} */
  const timers = [];
  /** @type {Set<string>} */
  let hosts = new Set();
  let closing = false;

  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxFrame, perMessageDeflate: false, clientTracking: false, handleProtocols: () => SUBPROTOCOL });

  /** The client's address and how it reached the gateway; forwarded headers count only from a trusted proxy. @param {http.IncomingMessage} request */
  function peerOf(request) {
    const remote = plain(request.socket.remoteAddress);
    const forwarded = request.headers['x-forwarded-for'];
    if (!config.trustProxy.has(remote) || typeof forwarded !== 'string') return { ip: remote, proxied: false, secure: !!config.tls };
    const chain = forwarded.split(',').map(entry => plain(entry.trim())).filter(Boolean);
    let ip = remote;
    while (chain.length) { ip = /** @type {string} */ (chain.pop()); if (!config.trustProxy.has(ip)) break; }
    const proto = String(request.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase();
    const forwardedHost = request.headers['x-forwarded-host'];
    return { ip, proxied: true, secure: proto === 'https', host: typeof forwardedHost === 'string' ? forwardedHost.split(',')[0].trim() : undefined };
  }

  /**
   * Why a request may not go on, or undefined: an unknown Host, or plaintext from beyond loopback.
   * @param {http.IncomingMessage} request @param {ReturnType<typeof peerOf>} peer
   */
  function refusal(request, peer) {
    const host = String(peer.host ?? request.headers.host ?? '').toLowerCase();
    if (!hosts.has(host)) return { status: 421, error: 'unknown_host' };
    if (peer.secure || config.allowInsecure) return undefined;
    if (!peer.proxied && isLoopbackAddress(request.socket.remoteAddress)) return undefined;
    return { status: 403, error: 'tls_required' };
  }

  /** The request's Origin when allowed (null without one), or false. @param {http.IncomingMessage} request */
  function originOf(request) {
    const origin = request.headers.origin;
    if (origin === undefined) return null;
    const normalized = String(origin).toLowerCase();
    return config.origins.has(normalized) ? normalized : false;
  }

  /** @param {string} ip */
  function blocked(ip) {
    const entry = failures.get(ip);
    if (!entry || entry.resetAt <= Date.now()) { failures.delete(ip); return undefined; }
    return entry.count >= limits.authFailures ? Math.ceil((entry.resetAt - Date.now()) / 1000) : undefined;
  }

  /** @param {string} ip @param {string} reason */
  function failed(ip, reason) {
    const now = Date.now();
    const entry = failures.get(ip);
    if (!entry || entry.resetAt <= now) failures.set(ip, { count: 1, resetAt: now + limits.authWindowMs });
    else entry.count++;
    if (failures.size > 10_000) for (const [key, value] of failures) if (value.resetAt <= now) failures.delete(key);
    logger.warn('refused an authentication', { code: 'ALP_GATEWAY_AUTH_FAILED', ip, reason });
  }

  /** @param {http.ServerResponse} response @param {number} status @param {unknown} body @param {Record<string, string>} [headers] */
  function json(response, status, body, headers = {}) {
    const text = JSON.stringify(body);
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-length': String(Buffer.byteLength(text)), ...headers });
    response.end(text);
  }

  /** CORS for an allowed browser origin; nothing for clients without one. @param {string | null} origin @returns {Record<string, string>} */
  const cors = origin => origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {};

  /** @param {http.IncomingMessage} request @param {http.ServerResponse} response */
  function onRequest(request, response) {
    const peer = peerOf(request);
    const refused = refusal(request, peer);
    if (refused) return json(response, refused.status, { error: refused.error });
    const { pathname } = new URL(request.url ?? '/', 'http://gateway');
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
        ...(grant.modes ? { modes: [...grant.modes] } : {}),
      },
    }, cors(origin));
  }

  /** @param {http.IncomingMessage} request @param {import('node:stream').Duplex} socket @param {Buffer} head */
  function onUpgrade(request, socket, head) {
    socket.on('error', () => {});
    /** @param {number} status @param {string} text @param {string} [reason] */
    const refuse = (status, text, reason) => {
      if (reason) logger.info('refused a WebSocket', { code: 'ALP_GATEWAY_UPGRADE_REFUSED', status, reason });
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`);
    };
    if (closing) return refuse(503, 'Service Unavailable');
    const peer = peerOf(request);
    const refused = refusal(request, peer);
    if (refused) return refuse(refused.status, refused.status === 421 ? 'Misdirected Request' : 'Forbidden', refused.error);
    if (new URL(request.url ?? '/', 'http://gateway').pathname !== WEBSOCKET_PATH) return refuse(404, 'Not Found');
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
    socket.once('close', () => { if (!settled) { release(); perPrincipal.set(grant.id, (perPrincipal.get(grant.id) ?? 1) - 1); } });
    wss.handleUpgrade(request, socket, head, ws => {
      release();
      const id = randomBytes(6).toString('hex');
      const log = logger.child({ connection: id, principal: grant.id, ip: peer.ip });
      const connection = new ClientConnection({
        ws, grant, id, connectUpstream, logger: log,
        limits: { maxPending: limits.maxPending, rate: limits.rate, burst: limits.burst, maxStrikes: limits.maxStrikes, handshakeMs: limits.handshakeMs, requestTimeoutMs: limits.requestTimeoutMs, maxBufferedBytes: limits.maxBufferedBytes, maxQueue: limits.maxQueue, closeGraceMs: limits.closeGraceMs },
        onClosed: (closed, code) => {
          connections.delete(closed);
          perPrincipal.set(grant.id, Math.max(0, (perPrincipal.get(grant.id) ?? 1) - 1));
          if (!perPrincipal.get(grant.id)) perPrincipal.delete(grant.id);
          log.info('closed a connection', { code: 'ALP_GATEWAY_DISCONNECTED', closeCode: code });
        },
      });
      if (!connection.closed) connections.add(connection);
      log.info('opened a connection', { code: 'ALP_GATEWAY_CONNECTED' });
    });
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
    }
  });

  /** @type {http.Server | https.Server | undefined} */
  let server;

  return {
    connections,
    tickets,
    get monitor() { return monitor; },
    /** Loads credentials, starts watching alpd and listens; resolves with the bound address. */
    async listen() {
      await store.reload();
      server = config.tls
        ? https.createServer({ cert: await readFile(config.tls.cert), key: await readFile(config.tls.key) }, onRequest)
        : http.createServer(onRequest);
      server.headersTimeout = 10_000;
      server.requestTimeout = 15_000;
      server.on('upgrade', onUpgrade);
      server.on('clientError', (_error, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch {} });
      const listening = /** @type {http.Server} */ (server);
      await new Promise((resolve, reject) => {
        listening.once('error', reject);
        listening.listen(config.port, config.host, () => { listening.off('error', reject); resolve(undefined); });
      });
      const { port } = /** @type {import('node:net').AddressInfo} */ (listening.address());
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
        const stopping = /** @type {http.Server} */ (server);
        await new Promise(resolve => { stopping.close(() => resolve(undefined)); stopping.closeAllConnections?.(); });
      }
    },
  };
}
