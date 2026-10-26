// A gateway on 127.0.0.1:0 in front of a fake daemon, with credentials made in a throwaway gateway
// home, and helpers to get tickets and open SDK or raw WebSocket clients the way remote clients do.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { AlpRpcClient, hello } from '@anhlp/alp-client/portable';
import { connectWebSocket } from '@anhlp/alp-client/websocket';
import { CredentialStore, createCredential, createGateway, createGatewayLogger, resolveConfig } from '../../src/index.js';

export const ORIGIN = 'https://app.example';

export async function until(check, what = 'condition', ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`${what} never happened`);
}

/**
 * @param {import('node:test').TestContext} t
 * @param {{ daemon: ReturnType<typeof import('./fake-daemon.js').fakeDaemon>, credentials?: Record<string, { workspaces: string[], permissions?: string[], modes?: string[], worktreeMappings?: string[] }>, config?: object, serveStatic?: Function }} options
 */
export async function startGateway(t, { daemon, credentials = {}, config = {}, serveStatic }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-gateway-'));
  const home = path.join(directory, 'gateway');
  const tokens = {};
  const ids = {};
  for (const [label, { workspaces, permissions = ['session.read', 'session.write', 'project.read', 'project.write'], modes, worktreeMappings }] of Object.entries(credentials)) {
    for (const workspace of workspaces) await mkdir(workspace, { recursive: true });
    const { credential, token } = await createCredential(home, { label, workspaces, permissions, ...(worktreeMappings ? {worktreeMappings}:{}), ...(modes ? { modes } : {}) });
    tokens[label] = token;
    ids[label] = credential.id;
  }
  const lines = [];
  const logger = createGatewayLogger({ level: 'debug', write: line => lines.push(line) });
  const store = new CredentialStore({ home, logger, pollMs: 25 });
  const gateway = createGateway({
    config: resolveConfig({ port: 0, origins: [ORIGIN], ...config }),
    store, logger, version: 'test', openTransport: daemon.open, monitorIntervalMs: 50, ...(serveStatic ? { serveStatic } : {}),
  });
  const address = await gateway.listen();
  t.after(async () => { await gateway.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const base = address.url;
  const wsUrl = `${base.replace(/^http/, 'ws')}/v1/ws`;

  /** POST /v1/tickets with a token. */
  async function ticket(token, { origin = ORIGIN, headers = {} } = {}) {
    const response = await fetch(`${base}/v1/tickets`, { method: 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}), ...headers } });
    return { status: response.status, body: await response.json().catch(() => undefined), headers: response.headers };
  }

  /** A raw ws client with the protocols a ticket gives; resolves once open, or with the HTTP refusal. */
  function raw(protocols, { origin = ORIGIN, url = wsUrl, maxPayload } = {}) {
    return new Promise(resolve => {
      const socket = new WebSocket(url, protocols, { ...(origin ? { origin } : {}), ...(maxPayload ? { maxPayload } : {}) });
      const frames = [];
      socket.on('message', data => frames.push(JSON.parse(data.toString('utf8'))));
      socket.once('open', () => resolve({ socket, frames, protocol: socket.protocol }));
      socket.once('unexpected-response', (_request, response) => resolve({ refused: response.statusCode }));
      socket.once('error', error => resolve({ error }));
    });
  }

  /** A raw client already through ticket and hello. */
  async function rawSession(label, options = {}) {
    const { body } = await ticket(tokens[label], options);
    const opened = await raw(body.subprotocols, options);
    if (!opened.socket) throw new Error(`could not open: ${JSON.stringify(opened.refused ?? opened.error?.message)}`);
    const { socket, frames } = opened;
    let next = 1000;
    const call = (method, params) => new Promise(resolve => {
      const id = next++;
      const onMessage = data => {
        const message = JSON.parse(data.toString('utf8'));
        if (message.id === id) { socket.off('message', onMessage); resolve(message); }
      };
      socket.on('message', onMessage);
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }));
    });
    const closed = new Promise(resolve => socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })));
    t.after(() => socket.terminate());
    return { socket, frames, call, closed };
  }

  /** The client SDK over the gateway, handshaken. */
  async function sdk(label, { origin = ORIGIN } = {}) {
    const { body } = await ticket(tokens[label], { origin });
    const transport = await connectWebSocket(wsUrl, { protocols: body.subprotocols, createSocket: (url, protocols) => new WebSocket(url, protocols, { origin }) });
    const client = new AlpRpcClient(transport);
    t.after(() => client.close());
    const greeting = await hello(client, { name: 'gateway-test', version: '0' });
    return { client, hello: greeting };
  }

  return { gateway, store, home, tokens, ids, lines, base, wsUrl, ticket, raw, rawSession, sdk };
}
