// A gateway on 127.0.0.1:0 in front of a fake daemon, with credentials made in a throwaway gateway
// home, and helpers to get tickets and open SDK or raw WebSocket clients the way remote clients do.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { AlpRpcClient, hello } from '@anhlp/alp-client/portable';
import { connectWebSocket } from '@anhlp/alp-client/websocket';
import { CredentialStore, createCredential, createGateway, createGatewayLogger, resolveConfig } from '../../dist/index.js';
import { teardown } from '../../../../test/support/teardown.ts';
import type { TestContext } from 'node:test';
import type { fakeDaemon } from './fake-daemon.ts';
import type { OwnerOption } from '../../dist/owner.js';

// `any`: tickets, frames and answers are JSON of every shape; the tests read their fields.
type Json = any;

export const ORIGIN = 'https://app.example';

export async function until(check: () => unknown, what = 'condition', ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error(`${what} never happened`);
}

/**
 * startGateway's options: `owner` builds createGateway's owner option from the ids of the credentials made here.
 */
type GatewayOptions = { daemon: ReturnType<typeof fakeDaemon>, credentials?: Record<string, { workspaces: string[], permissions?: string[], modes?: string[], worktreeMappings?: string[], agent?: boolean | string }>, config?: object, serveStatic?: Json, owner?: (ids: Record<string, string>) => OwnerOption };
/** How a client reaches the gateway: the Origin header, extra headers, the WebSocket URL and its maxPayload. */
type ClientOptions = { origin?: string | null, headers?: Record<string, string>, url?: string, maxPayload?: number };

export async function startGateway(t: TestContext, { daemon, credentials = {}, config = {}, serveStatic, owner }: GatewayOptions) {
  // One ordered list, shared with the calling test through teardown(t) (t-5294.6, review finding M).
  // This used to be three bare `t.after` hooks: one that closed the gateway and store and THEN
  // removed the directory, and two later ones terminating a socket and closing an SDK client. Since
  // node:test runs hooks in registration order and stops at the first that throws, a routine
  // ENOTEMPTY in that removal stranded the socket and the client — and in a test that also used
  // teardown(t), the defer list ran first and stranded the gateway itself. Every step now goes in
  // setup order and is undone in reverse, so nothing in here can be skipped by an earlier failure.
  const defer = teardown(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-gateway-'));
  defer(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'gateway');
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};
  for (const [label, { workspaces, permissions = ['session.read', 'session.write', 'project.read', 'project.write'], modes, worktreeMappings, agent }] of Object.entries(credentials)) {
    for (const workspace of workspaces) await mkdir(workspace, { recursive: true });
    const { credential, token } = await createCredential(home, { label, workspaces, permissions, ...(worktreeMappings ? {worktreeMappings}:{}), ...(modes ? { modes } : {}), ...(agent ? { agent } : {}) });
    tokens[label] = token;
    ids[label] = credential.id;
  }
  const lines: string[] = [];
  const logger = createGatewayLogger({ level: 'debug', write: line => lines.push(line) });
  const store = new CredentialStore({ home, logger, pollMs: 25 });
  const gateway = createGateway({
    config: resolveConfig({ port: 0, origins: [ORIGIN], ...config }),
    store, logger, version: 'test', openTransport: daemon.open, monitorIntervalMs: 50, ...(serveStatic ? { serveStatic } : {}), ...(owner ? { owner: owner(ids) } : {}),
  });
  defer(() => store.close());
  const address = await gateway.listen();
  defer(() => gateway.close());
  const base = address.url;
  const wsUrl = `${base.replace(/^http/, 'ws')}/v1/ws`;

  /** POST /v1/tickets with a token. */
  async function ticket(token: string | undefined, { origin = ORIGIN, headers = {} }: ClientOptions = {}) {
    const response = await fetch(`${base}/v1/tickets`, { method: 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}), ...headers } });
    return { status: response.status, body: await response.json().catch(() => undefined) as Json, headers: response.headers };
  }

  /** A raw ws client with the protocols a ticket gives; resolves once open, or with the HTTP refusal. */
  function raw(protocols: Json, { origin = ORIGIN, url = wsUrl, maxPayload }: ClientOptions = {}) {
    return new Promise<Json>(resolve => {
      const socket = new WebSocket(url, protocols, { ...(origin ? { origin } : {}), ...(maxPayload ? { maxPayload } : {}) });
      const frames: Json[] = [];
      socket.on('message', data => frames.push(JSON.parse(data.toString('utf8'))));
      socket.once('open', () => resolve({ socket, frames, protocol: socket.protocol }));
      socket.once('unexpected-response', (_request, response) => resolve({ refused: response.statusCode }));
      socket.once('error', error => resolve({ error }));
    });
  }

  /** A raw client already through ticket and hello. */
  async function rawSession(label: string, options: ClientOptions = {}) {
    const { body } = await ticket(tokens[label], options);
    const opened = await raw(body.subprotocols, options);
    if (!opened.socket) throw new Error(`could not open: ${JSON.stringify(opened.refused ?? opened.error?.message)}`);
    const { socket, frames } = opened;
    let next = 1000;
    const call = (method: string, params?: Json) => new Promise<Json>(resolve => {
      const id = next++;
      const onMessage = (data: Json) => {
        const message = JSON.parse(data.toString('utf8'));
        if (message.id === id) { socket.off('message', onMessage); resolve(message); }
      };
      socket.on('message', onMessage);
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }));
    });
    const closed = new Promise<{ code: number, reason: string }>(resolve => socket.once('close', (code: number, reason: Buffer) => resolve({ code, reason: reason.toString() })));
    defer(() => socket.terminate());
    return { socket, frames, call, closed };
  }

  /** The client SDK over the gateway, handshaken. */
  async function sdk(label: string, { origin = ORIGIN, headers }: { origin?: string, headers?: Record<string, string> } = {}) {
    const { body } = await ticket(tokens[label], { origin });
    const transport = await connectWebSocket(wsUrl, { protocols: body.subprotocols, createSocket: (url, protocols) => new WebSocket(url, protocols, { origin, ...(headers ? { headers } : {}) }) });
    const client = new AlpRpcClient(transport);
    defer(() => client.close());
    const greeting = await hello(client, { name: 'gateway-test', version: '0' });
    return { client, hello: greeting as Json };
  }

  return { gateway, store, home, tokens, ids, lines, base, wsUrl, ticket, raw, rawSession, sdk };
}
