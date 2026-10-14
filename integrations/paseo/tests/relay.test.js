import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { createClientChannel } from '@getpaseo/relay/e2ee';
import { parseConnectionOfferFromUrl } from '@getpaseo/protocol/connection-offer';
import { validateWSOutboundMessage } from '@getpaseo/protocol/validation/ws-outbound';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { createDaemonServer } from '@anhlp/alp-daemon';
import { createWebServer } from 'alp-paseo-plugin';
import { createPaseoBridge } from 'alp-paseo-plugin';
import { fakeTransport, until } from '../../../test/support/fake-agent.js';

/**
 * A relay as Paseo's (protocol v2) behaves: the daemon's control socket hears which devices
 * connect, the daemon opens a data socket per device, and the relay passes bytes between them.
 */
async function fakeRelay(t) {
  const server = http.createServer();
  const sockets = new WebSocketServer({ server, path: '/ws' });
  const controls = new Map();
  const devices = new Map();
  const seen = [];
  sockets.on('connection', (ws, request) => {
    const url = new URL(request.url, 'http://relay');
    const serverId = url.searchParams.get('serverId');
    const role = url.searchParams.get('role');
    const connectionId = url.searchParams.get('connectionId');
    seen.push({ serverId, role, connectionId, v: url.searchParams.get('v') });
    if (role === 'server' && !connectionId) {
      controls.set(serverId, ws);
      ws.send(JSON.stringify({ type: 'sync', connectionIds: [...devices.keys()] }));
      return;
    }
    if (role === 'client') {
      const id = randomUUID();
      const device = { ws, queue: [], daemon: undefined };
      devices.set(id, device);
      ws.on('message', (data, binary) => device.daemon ? device.daemon.send(data, { binary }) : device.queue.push([data, binary]));
      ws.on('close', () => { devices.delete(id); device.daemon?.close(); controls.get(serverId)?.send(JSON.stringify({ type: 'disconnected', connectionId: id })); });
      controls.get(serverId)?.send(JSON.stringify({ type: 'connected', connectionId: id }));
      return;
    }
    const device = devices.get(connectionId);
    if (!device) { ws.close(1008, 'unknown connection'); return; }
    device.daemon = ws;
    ws.on('message', (data, binary) => device.ws.send(data, { binary }));
    ws.on('close', () => device.ws.close());
    for (const [data, binary] of device.queue.splice(0)) ws.send(data, { binary });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const ws of sockets.clients) ws.terminate(); await new Promise(resolve => server.close(resolve)); });
  return { endpoint: `127.0.0.1:${server.address().port}`, seen, controls };
}

async function setup(t, relay = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-relay-'));
  const home = path.join(directory, 'home');
  const runtime = createAlpRuntime({ language: 'English', transport: fakeTransport([]), supervisor: false, libraryDir: home });
  const daemon = createDaemonServer({ runtime, socketPath: '', version: 'test' });
  let web;
  const gateway = createPaseoBridge({ clientFactory: async (onEvent) => {
    const client = daemon.local();
    client.onEvent(onEvent);
    return { request: client.request.bind(client), close: client.close.bind(client), onClose: client.onClose.bind(client) };
  }, version: 'test', home, token: () => web.token, serverId: () => web.serverId, relay, listen: () => 'here' });
  web = createWebServer({ home, port: 0, app: { dir: directory, gateway } });
  const info = await web.listen();
  await gateway.relay.start();
  t.after(async () => { await web.close(); await gateway.relay.stop(); await runtime.shutdown(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return { home, info, gateway };
}

/** The app's side of a socket: frames in, frames out, each checked against Paseo's validator. */
function frames(t, send) {
  const received = [];
  const waiting = [];
  return {
    received,
    take(frame) {
      const checked = validateWSOutboundMessage(frame);
      assert.ok(checked.success, `alpd sent a frame Paseo's app drops: ${JSON.stringify(frame).slice(0, 300)}`);
      received.push(frame);
      for (const wait of [...waiting]) if (wait.test(frame)) { waiting.splice(waiting.indexOf(wait), 1); wait.resolve(frame); }
    },
    next: test => new Promise(resolve => { const found = received.find(test); if (found) resolve(found); else waiting.push({ test, resolve }); }),
    send: frame => send(JSON.stringify(frame)),
  };
}

/** A device as Paseo's app pairs: it reads the link, opens the relay as a client and runs the E2EE handshake. */
async function device(t, url) {
  const offer = parseConnectionOfferFromUrl(url);
  assert.ok(offer, 'the pairing link carries an offer');
  const ws = new WebSocket(`ws://${offer.relay.endpoint}/ws?serverId=${encodeURIComponent(offer.serverId)}&role=client&v=2`);
  t.after(() => ws.terminate());
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const transport = { send: data => ws.send(data), close: (code, reason) => ws.close(code, reason), onmessage: null, onclose: null, onerror: null };
  ws.on('message', (data, isBinary) => transport.onmessage?.({ data: isBinary ? new Uint8Array(data).buffer : String(data), isBinary }));
  ws.on('close', (code, reason) => transport.onclose?.(code, String(reason)));
  let app;
  const channel = await createClientChannel(transport, offer.daemonPublicKeyB64, { onmessage: data => app.take(JSON.parse(String(data))) });
  app = frames(t, data => channel.send(data));
  const closed = new Promise(resolve => ws.on('close', code => resolve(code)));
  return { ...app, offer, closed };
}

const hello = password => ({ type: 'hello', clientId: `cid-${randomUUID()}`, clientType: 'mobile', protocolVersion: 1, capabilities: { helloRejection: true }, ...(password ? { auth: { kind: 'password', password } } : {}) });

test('the pairing link is a Paseo offer with alpd\'s server id, its kept public key and the relay', async t => {
  const relay = await fakeRelay(t);
  const { home, info, gateway } = await setup(t, { enabled: true, endpoint: relay.endpoint, useTls: false });
  const { url, relayEnabled } = await gateway.relay.offer();
  assert.equal(relayEnabled, true);
  assert.match(url, /^https:\/\/app\.paseo\.sh\/#offer=/);
  const offer = parseConnectionOfferFromUrl(url);
  assert.equal(offer.serverId, info.serverId);
  assert.deepEqual(offer.relay, { endpoint: relay.endpoint, useTls: false });
  const kept = JSON.parse(await readFile(path.join(home, 'relay-keypair.json'), 'utf8'));
  assert.equal(kept.publicKeyB64, offer.daemonPublicKeyB64);
  assert.equal((await stat(path.join(home, 'relay-keypair.json'))).mode & 0o777, 0o600);
  assert.equal(parseConnectionOfferFromUrl((await gateway.relay.offer()).url).daemonPublicKeyB64, offer.daemonPublicKeyB64, 'the key is kept');
  assert.equal(url.includes(info.token), false, 'the link carries no token');
});

test('a paired device reaches alpd through the relay, encrypted, and signs in with the token', async t => {
  const relay = await fakeRelay(t);
  const { info, gateway } = await setup(t, { enabled: true, endpoint: relay.endpoint, useTls: false });
  await until(() => gateway.relay.connected);
  assert.deepEqual(relay.seen[0], { serverId: info.serverId, role: 'server', connectionId: null, v: '2' });
  const { url } = await gateway.relay.offer();

  const stranger = await device(t, url);
  stranger.send(hello());
  const refused = await stranger.next(frame => frame.type === 'hello.rejected');
  assert.equal(refused.reason, 'password_required', 'the link alone does not let a device in');

  const phone = await device(t, url);
  phone.send(hello(info.token));
  const status = await phone.next(frame => frame.message?.payload?.status === 'server_info');
  assert.equal(status.message.payload.serverId, info.serverId);
  assert.equal(status.message.payload.features.relayConfig, true);
  phone.send({ type: 'session', message: { type: 'daemon.get_status.request', requestId: 's1' } });
  const daemonStatus = (await phone.next(frame => frame.message?.payload?.requestId === 's1')).message.payload;
  assert.equal(daemonStatus.relay.enabled, true);
  assert.equal(daemonStatus.relay.endpoint, relay.endpoint);
  assert.equal(daemonStatus.listen, 'here');
  assert.ok(relay.seen.some(socket => socket.role === 'server' && socket.connectionId), 'alpd opened a data socket for the device');
});

test('the web app turns the relay on and off, kept in settings.json; other config changes are in development', async t => {
  const relay = await fakeRelay(t);
  const { home, info, gateway } = await setup(t, { endpoint: relay.endpoint, useTls: false });
  const ws = new WebSocket(`ws://127.0.0.1:${info.port}/ws`, { headers: { Origin: `http://127.0.0.1:${info.port}` } });
  t.after(() => ws.terminate());
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const app = frames(t, data => ws.send(data));
  ws.on('message', data => app.take(JSON.parse(String(data))));
  app.send(hello(info.token));
  const features = (await app.next(frame => frame.message?.payload?.status === 'server_info')).message.payload.features;
  assert.equal(features.daemonStatusRpc, true);
  const ask = async message => { app.send({ type: 'session', message }); return (await app.next(frame => frame.message?.payload?.requestId === message.requestId)).message; };

  const off = await ask({ type: 'daemon.get_pairing_offer.request', requestId: 'p1' });
  assert.deepEqual([off.payload.relayEnabled, off.payload.url], [false, '']);
  assert.equal((await ask({ type: 'get_daemon_config_request', requestId: 'c1' })).payload.config.relay.enabled, false);
  assert.equal(relay.seen.length, 0, 'nothing reaches the relay while it is off');

  const on = await ask({ type: 'set_daemon_config_request', requestId: 'c2', config: { relay: { enabled: true } } });
  assert.equal(on.payload.config.relay.enabled, true);
  await app.next(frame => frame.message?.payload?.status === 'daemon_config_changed');
  assert.equal(JSON.parse(await readFile(path.join(home, 'settings.json'), 'utf8')).web.relay.enabled, true);
  await until(() => gateway.relay.connected);
  const paired = await ask({ type: 'daemon.get_pairing_offer.request', requestId: 'p2' });
  assert.equal(parseConnectionOfferFromUrl(paired.payload.url).serverId, info.serverId);

  const other = await ask({ type: 'set_daemon_config_request', requestId: 'c3', config: { autoArchiveAfterMerge: true } });
  assert.equal(other.type, 'rpc_error');
  assert.equal(other.payload.code, 'not_implemented');

  await ask({ type: 'set_daemon_config_request', requestId: 'c4', config: { relay: { enabled: false } } });
  await until(() => !gateway.relay.connected);
  assert.equal(JSON.parse(await readFile(path.join(home, 'settings.json'), 'utf8')).web.relay.enabled, false);
});
