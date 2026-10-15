// The Node transport over a real Unix socket or Windows named pipe, against a small fake alpd:
// the compatibility client (`connect`, `new AlpClient(socket)`) and the new `connectSocket` share
// the portable engine and keep the private-socket checks (docs/alp/client-sdk.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AlpClient, AlpRpcClient, connect, connectSocket, daemonPaths, hello, isAlpClientError, PROTOCOL_VERSION } from '@anhlp/alp-client';

const windows = process.platform === 'win32';

/** A fake alpd that speaks the handshake and a few test methods; writes go out in fragments. */
async function fakeDaemon(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-ipc-'));
  const socketPath = daemonPaths(directory).socket;
  const connections = new Set();
  const received = [];
  const server = net.createServer(socket => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    let buffer = '';
    const asked = new Map();
    // Fragmented writes prove the client reassembles frames that arrive in pieces.
    let queue = Promise.resolve();
    const write = value => {
      const text = `${JSON.stringify(value)}\n`;
      const cut = Math.floor(text.length / 2);
      queue = queue.then(async () => {
        socket.write(text.slice(0, cut));
        await new Promise(resolve => setTimeout(resolve, 1));
        socket.write(text.slice(cut));
      });
    };
    socket.on('data', chunk => {
      buffer += chunk;
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const message = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        received.push(message);
        if (!message.method) { asked.get(message.id)?.(message); continue; }
        const reply = result => write({ jsonrpc: '2.0', id: message.id, result });
        switch (message.method) {
          case 'daemon.hello': reply({ protocolVersion: PROTOCOL_VERSION }); break;
          case 'daemon.status': reply({ ok: true }); break;
          case 'test.stream':
            for (let seq = 1; seq <= 3; seq++) write({ jsonrpc: '2.0', method: 'event', params: { sessionId: 'ses_1', seq, event: { type: 'item' } } });
            setTimeout(() => reply({ streamed: 3 }), 5);
            break;
          case 'test.ask':
            asked.set('d1', answer => reply({ answer: answer.result ?? answer.error }));
            write({ jsonrpc: '2.0', id: 'd1', method: 'extension.call', params: { x: 1 } });
            break;
          case 'test.huge': socket.write(`${'x'.repeat(4096)}`); break;
          case 'test.kill': socket.destroy(); break;
          default: break; // test.never: no answer
        }
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  if (!windows) await chmod(socketPath, 0o600);
  t.after(async () => {
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, socketPath, received, connections };
}

test('connect: handshake, requests, streamed events and frames arriving in pieces', async t => {
  const daemon = await fakeDaemon(t);
  const client = await connect(daemon.socketPath, { name: 'test', version: '1' });
  t.after(() => client.close());
  assert.ok(client instanceof AlpClient && client instanceof AlpRpcClient);
  assert.deepEqual(daemon.received[0].params, { protocolVersion: PROTOCOL_VERSION, client: { name: 'test', version: '1' } });
  const events = [];
  client.onEvent(envelope => events.push(envelope.seq));
  assert.deepEqual(await client.request('test.stream'), { streamed: 3 });
  assert.deepEqual(events, [1, 2, 3]);
  assert.deepEqual(await client.request('daemon.status'), { ok: true });
});

test('connect: requests alpd sends the client are answered by onRequest', async t => {
  const daemon = await fakeDaemon(t);
  const client = await connect(daemon.socketPath);
  t.after(() => client.close());
  client.onRequest((method, params) => ({ method, doubled: params.x * 2 }));
  assert.deepEqual(await client.request('test.ask'), { answer: { method: 'extension.call', doubled: 2 } });
});

test('connectSocket gives a transport for the portable client; hello makes it the same as connect', async t => {
  const daemon = await fakeDaemon(t);
  const client = new AlpRpcClient(await connectSocket(daemon.socketPath));
  t.after(() => client.close());
  assert.equal((await hello(client, { name: 'portable', version: '0' })).protocolVersion, PROTOCOL_VERSION);
  assert.deepEqual(await client.request('daemon.status'), { ok: true });
});

test('the socket constructor still accepts a socket that is still connecting', async t => {
  const daemon = await fakeDaemon(t);
  const raw = new AlpClient(net.createConnection(daemon.socketPath));
  t.after(() => raw.close());
  assert.equal((await raw.request('daemon.hello', { protocolVersion: PROTOCOL_VERSION })).protocolVersion, PROTOCOL_VERSION);
});

test('a daemon that drops the connection rejects what waits as disconnected, and onClose runs once', async t => {
  const daemon = await fakeDaemon(t);
  const client = await connect(daemon.socketPath);
  const closes = [];
  client.onClose(error => closes.push(error));
  const never = client.request('test.never');
  await assert.rejects(client.request('test.kill'), error => isAlpClientError(error, 'disconnected'));
  await assert.rejects(never, error => isAlpClientError(error, 'disconnected'));
  assert.equal(closes.length, 1);
  await assert.rejects(client.request('daemon.status'), /ALP daemon connection closed/);
});

test('close() rejects what waits with the message callers match on and ends the socket', async t => {
  const daemon = await fakeDaemon(t);
  const client = await connect(daemon.socketPath);
  const never = client.request('test.never');
  await new Promise(resolve => setTimeout(resolve, 10));
  client.close();
  await assert.rejects(never, /ALP daemon connection closed/);
  for (let i = 0; i < 100 && daemon.connections.size; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(daemon.connections.size, 0, 'the daemon saw the connection end');
});

test('a frame over the limit closes the connection as a protocol error', async t => {
  const daemon = await fakeDaemon(t);
  const client = await connect(daemon.socketPath, undefined, { maxFrame: 1024 });
  await assert.rejects(client.request('test.huge'), error => isAlpClientError(error, 'protocol') && error.message === 'ALP daemon frame exceeds size limit');
  assert.equal(client.closed, true);
});

test('the write buffer is bounded; a send beyond it fails without being queued', async t => {
  const daemon = await fakeDaemon(t);
  const client = new AlpClient(net.createConnection(daemon.socketPath), { maxBufferedBytes: 16 });
  t.after(() => client.close());
  await assert.rejects(client.request('daemon.status', { padding: 'x'.repeat(64) }), error => isAlpClientError(error, 'send_failed'));
  assert.equal(client.closed, false);
});

test('connectSocket and connect refuse a socket other users can reach, before any handshake', { skip: windows && 'named-pipe ACLs are an OS deployment assumption' }, async t => {
  const daemon = await fakeDaemon(t);
  await chmod(daemon.socketPath, 0o666);
  await assert.rejects(connectSocket(daemon.socketPath), /private permissions/);
  await assert.rejects(connect(daemon.socketPath), /private permissions/);
  await chmod(daemon.socketPath, 0o600);
  await chmod(daemon.directory, 0o755);
  await assert.rejects(connectSocket(daemon.socketPath), /private permissions \(0700\)/);
  await chmod(daemon.directory, 0o700);
  assert.equal(daemon.received.length, 0, 'nothing reached the daemon');
});
