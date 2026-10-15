import { MAX_FRAME } from '@anhlp/alp-protocol';
import { AlpClientError } from './rpc/errors.js';
import { createLineDecoder } from './rpc/framing.js';

/**
 * The Node transport of the ALP client: a Unix socket or Windows named pipe carrying
 * newline-delimited JSON (plans/reference/ALPD.md §3). Node-only; the portable engine
 * (`@anhlp/alp-client/portable`) never imports it. Socket discovery, the private-socket checks
 * and daemon startup stay in the Node entry (`connect`, `ensureDaemon`).
 *
 * @typedef {import('./rpc/client.js').AlpTransport} AlpTransport
 * @typedef {import('./rpc/client.js').TransportClose} TransportClose
 * @typedef {{ maxFrame?: number, maxBufferedBytes?: number }} SocketTransportOptions
 *   `maxBufferedBytes` bounds what may wait in the socket's write buffer; a send beyond it fails
 *   as `send_failed` instead of growing memory while the daemon does not read.
 */

/**
 * Wraps a connected or still-connecting socket (writes made while it connects are queued by
 * Node). The transport owns the socket from then on.
 * @param {import('node:net').Socket} socket
 * @param {SocketTransportOptions} [options]
 * @returns {AlpTransport}
 */
export function createSocketTransport(socket, { maxFrame = MAX_FRAME, maxBufferedBytes = 4 * MAX_FRAME } = {}) {
  const decoder = createLineDecoder({ maxFrame });
  /** @type {Set<(frame: string) => void>} */
  const messages = new Set();
  /** @type {Set<(close: TransportClose) => void>} */
  const closes = new Set();
  /** @type {TransportClose | undefined} */
  let ended;
  /** @param {TransportClose} close */
  const end = close => {
    if (ended) return;
    ended = close;
    socket.off('data', onData);
    messages.clear();
    const listeners = [...closes];
    closes.clear();
    for (const listener of listeners) listener(close);
  };
  /** @param {string} chunk */
  const onData = chunk => {
    if (ended) return;
    let frames;
    try { frames = decoder.push(chunk); } catch {
      const error = new AlpClientError('ALP daemon frame exceeds size limit', { reason: 'protocol' });
      socket.destroy();
      return end({ error });
    }
    for (const frame of frames) {
      if (ended) return;
      for (const listener of [...messages]) listener(frame);
    }
  };
  socket.setEncoding('utf8');
  socket.on('data', onData);
  socket.on('error', error => end({ error }));
  socket.on('close', () => end({}));
  if (socket.destroyed) end({});
  return {
    get state() { return ended || socket.destroyed ? 'closed' : 'open'; },
    send(frame) {
      if (ended || socket.destroyed || socket.writableEnded) throw new AlpClientError('ALP daemon connection closed', { reason: 'send_failed' });
      if (socket.writableLength + frame.length > maxBufferedBytes) throw new AlpClientError(`ALP socket write buffer is over ${maxBufferedBytes} bytes`, { reason: 'send_failed' });
      socket.write(`${frame}\n`);
    },
    onMessage(listener) {
      if (ended) return () => false;
      messages.add(listener);
      return () => messages.delete(listener);
    },
    onClose(listener) {
      if (ended) return () => false;
      closes.add(listener);
      return () => closes.delete(listener);
    },
    close() {
      if (ended) return;
      // end() lets frames already written reach the daemon, as the client always did.
      socket.end();
      end({});
    },
  };
}
