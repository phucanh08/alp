/**
 * An in-memory AlpTransport for the portable client's tests: records what the client sends and
 * lets a test play the daemon's side.
 */
export function fakeTransport({ failSend } = {}) {
  const messages = new Set();
  const closes = new Set();
  let ended;
  const transport = {
    sent: [],
    closeCalls: 0,
    get state() { return ended ? 'closed' : 'open'; },
    send(frame) {
      if (ended) throw new Error('fake transport is closed');
      if (failSend) throw failSend;
      transport.sent.push(JSON.parse(frame));
    },
    onMessage(listener) { messages.add(listener); return () => messages.delete(listener); },
    onClose(listener) { closes.add(listener); return () => closes.delete(listener); },
    close() { transport.closeCalls++; transport.drop({}); },
    /** Delivers a frame as the daemon would; an object is serialized first. */
    deliver(frame) { for (const listener of [...messages]) listener(typeof frame === 'string' ? frame : JSON.stringify(frame)); },
    /** Ends the connection from the far side. */
    drop(close = {}) {
      if (ended) return;
      ended = close;
      messages.clear();
      const listeners = [...closes];
      closes.clear();
      for (const listener of listeners) listener(close);
    },
    get listenerCount() { return messages.size + closes.size; },
    /** Answers the last request sent. */
    reply(result, id = transport.sent.at(-1).id) { transport.deliver({ jsonrpc: '2.0', id, result }); },
  };
  return transport;
}

export const tick = () => new Promise(resolve => setTimeout(resolve, 0));
