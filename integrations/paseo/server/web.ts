import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { MAX_FRAME } from '@anhlp/alp-client/index';

/**
 * The Paseo integration's local listener (ALPD §61, §62): a socket on 127.0.0.1, at a port the
 * system picks (alp-web owns `web.port` and web.json), that speaks Paseo's protocol through the
 * bridge. The socket needs the token kept in $ALP_HOME/paseo.json, which is also the password
 * Paseo's app asks for. Only `daemon.get_status` (which reports this address) and
 * token-authenticated Paseo sockets use this listener; relay sockets attach to the bridge directly.
 * It served Paseo's web app (paseo-web) until that app was removed (t-55ce.3); `alp web` now serves
 * ALP's own app (apps/web), so this listener answers plain HTTP requests with 404. Requests must
 * name this host and port (no DNS rebinding), and the socket must come from this listener's own
 * origin (no other site in the browser).
 */

/**
 * @deprecated The integration no longer listens on `web.port` (alp-web does); it binds port 0.
 * Kept for one release for importers of `@anhlp/alp-paseo/web`.
 */
export const DEFAULT_WEB_PORT = 7433;
const BEARER_PREFIX = 'paseo.bearer.';
function bearerOf(protocols: Iterable<string>) { for (const protocol of protocols) if (protocol.startsWith(BEARER_PREFIX)) return protocol; return undefined; }
/** Ports tried after a busy one. */
const PORT_TRIES = 10;

export type WebInfo = { port: number; token: string; url: string; pid: number; serverId: string };

/** The Paseo bridge: each socket it is given speaks Paseo's protocol over alpd. */
export type WebGateway = { attach(ws: any, options?: { bearer?: string }): void; close?(): void };
/** @deprecated Pass `gateway`; `dir` is ignored since Paseo's web app was removed. Kept for one release. */
export type WebApp = { dir?: string; gateway: WebGateway };

/** Where the integration records its address, token and server id: `<home>/paseo.json`. */
export function webFile(home: string) {
  return path.join(home, 'paseo.json');
}

/** Before the rename the integration kept its identity in `<home>/web.json`, which alp-web now owns. */
const legacyWebFile = (home: string) => path.join(home, 'web.json');

/**
 * The token and the server id are made once and kept, so a paired device survives alpd restarts.
 * Without paseo.json, an identity the integration wrote to web.json before the rename is carried
 * over once (alp-web's own web.json names `app: 'alp-web'` and is never read).
 */
async function lastIdentity(home: string) {
  let kept: { token?: unknown; serverId?: unknown; app?: unknown } = {};
  try { kept = JSON.parse(await readFile(webFile(home), 'utf8')); } catch (error: any) {
    if (error?.code === 'ENOENT') {
      try {
        const legacy = JSON.parse(await readFile(legacyWebFile(home), 'utf8'));
        if (legacy && typeof legacy === 'object' && legacy.app === undefined) kept = legacy;
      } catch {}
    }
  }
  return {
    token: typeof kept.token === 'string' && /^[a-f0-9]{64}$/.test(kept.token) ? kept.token : randomBytes(32).toString('hex'),
    serverId: typeof kept.serverId === 'string' && /^alp-[a-f0-9]{16}$/.test(kept.serverId) ? kept.serverId : `alp-${randomBytes(8).toString('hex')}`,
  };
}

/** What every plain HTTP request gets: there is no page here. */
const NO_PAGE = 'Not found: this is the Paseo bridge\'s socket, not a web page. Open ALP\'s web app with `alp web`.\n';

export function createWebServer({ gateway: given, app, home, port = 0, log = () => {} }: {
  /** The bridge each authenticated socket is attached to; without it the socket is refused. */
  gateway?: WebGateway;
  /** @deprecated Use `gateway`. */
  app?: WebApp;
  home: string;
  /** 0 (the default) lets the system pick; a fixed port is tried with the next nine. */
  port?: number;
  log?: (message: string) => void;
}) {
  const gateway = given ?? app?.gateway;
  let token = '';
  let serverId = '';
  let bound = 0;
  const hosts = () => new Set([`127.0.0.1:${bound}`, `localhost:${bound}`]);
  const origins = () => new Set([`http://127.0.0.1:${bound}`, `http://localhost:${bound}`]);
  const headers = {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  };

  const server = http.createServer((request, response) => {
    if (!hosts().has(request.headers.host ?? '')) { response.writeHead(403, headers).end('Forbidden host\n'); return; }
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405, headers).end(); return; }
    response.writeHead(404, headers);
    response.end(request.method === 'HEAD' ? undefined : NO_PAGE);
  });

  // A browser carries Paseo's password as a subprotocol and needs it echoed to keep the socket.
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, handleProtocols: protocols => bearerOf(protocols) ?? false });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const refuse = (status: string) => { socket.end(`HTTP/1.1 ${status}\r\n\r\n`); };
    if (url.pathname !== '/ws' || !hosts().has(request.headers.host ?? '')) return refuse('403 Forbidden');
    if (!origins().has(request.headers.origin ?? '')) return refuse('403 Forbidden');
    if (!gateway) return refuse('404 Not Found');
    // The token comes with the hello (or as the subprotocol) and the gateway checks it.
    sockets.handleUpgrade(request, socket, head, ws => gateway.attach(ws, { bearer: ws.protocol || undefined }));
  });

  return {
    get token() { return token; },
    get serverId() { return serverId; },
    /** Listens on `port` (or the first free one after it), and records where in paseo.json. */
    async listen(): Promise<WebInfo> {
      ({ token, serverId } = await lastIdentity(home));
      for (let attempt = 0; ; attempt++) {
        const candidate = port + attempt;
        try {
          await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(candidate, '127.0.0.1', () => { server.off('error', reject); resolve(); });
          });
          bound = candidate;
          break;
        } catch (error: any) {
          if (error?.code !== 'EADDRINUSE' || attempt + 1 >= PORT_TRIES || port === 0) throw error;
          log(`port ${candidate} is in use; trying ${candidate + 1}`);
        }
      }
      bound = (server.address() as { port: number }).port;
      const info: WebInfo = { port: bound, token, url: `http://127.0.0.1:${bound}/`, pid: process.pid, serverId };
      await mkdir(home, { recursive: true, mode: 0o700 });
      await writeFile(`${webFile(home)}.tmp`, JSON.stringify(info), { mode: 0o600 });
      await rename(`${webFile(home)}.tmp`, webFile(home));
      return info;
    },

    async close() {
      for (const client of sockets.clients) client.terminate();
      gateway?.close?.();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
