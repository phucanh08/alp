import type { TestContext } from 'node:test';
import type { TransportClose } from '@anhlp/alp-client/portable';

// `any`: the frames the client sent are JSON-RPC requests of every method; the tests read the fields they assert on.
type Json = any;

/**
 * An in-memory AlpTransport for the portable client's tests: records what the client sends and
 * lets a test play the daemon's side.
 */
export function fakeTransport({ failSend }: { failSend?: unknown } = {}) {
  const messages = new Set<(frame: string) => void>();
  const closes = new Set<(close: TransportClose) => void>();
  let ended: TransportClose | undefined;
  const transport = {
    sent: [] as Json[],
    closeCalls: 0,
    get state(): 'closed' | 'open' { return ended ? 'closed' : 'open'; },
    send(frame: string) {
      if (ended) throw new Error('fake transport is closed');
      if (failSend) throw failSend;
      transport.sent.push(JSON.parse(frame));
    },
    onMessage(listener: (frame: string) => void) { messages.add(listener); return () => messages.delete(listener); },
    onClose(listener: (close: TransportClose) => void) { closes.add(listener); return () => closes.delete(listener); },
    close() { transport.closeCalls++; transport.drop({}); },
    /** Delivers a frame as the daemon would; an object is serialized first. */
    deliver(frame: unknown) { for (const listener of [...messages]) listener(typeof frame === 'string' ? frame : JSON.stringify(frame)); },
    /** Ends the connection from the far side. */
    drop(close: TransportClose = {}) {
      if (ended) return;
      ended = close;
      messages.clear();
      const listeners = [...closes];
      closes.clear();
      for (const listener of listeners) listener(close);
    },
    get listenerCount() { return messages.size + closes.size; },
    /** Answers the last request sent. */
    reply(result: unknown, id: unknown = transport.sent.at(-1).id) { transport.deliver({ jsonrpc: '2.0', id, result }); },
  };
  return transport;
}

export const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/**
 * Tracks the timers code under test sets and has not cleared or run yet, so a test can assert that
 * nothing is left behind (node --test does not fail on a leftover timer by itself).
 */
export function liveTimers(t: TestContext) {
  const live = new Set<NodeJS.Timeout>();
  const set = globalThis.setTimeout;
  const clear = globalThis.clearTimeout;
  // `any`: the replacement forwards whatever callback and arguments the code under test passes.
  globalThis.setTimeout = ((fn: (...values: any[]) => void, ms?: number, ...args: any[]) => {
    const id = set((...values: any[]) => { live.delete(id); fn(...values); }, ms, ...args);
    live.add(id);
    return id;
  }) as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((id: NodeJS.Timeout) => { live.delete(id); clear(id); }) as typeof globalThis.clearTimeout;
  t.after(() => { for (const id of live) clear(id); globalThis.setTimeout = set; globalThis.clearTimeout = clear; });
  return live;
}
