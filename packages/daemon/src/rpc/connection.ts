import type net from 'node:net';

/** One client of alpd (a socket, the in-process local() or an accepted transport) as its handlers see it. */
export type Connection = {
  socket?: net.Socket;
  helloed: boolean;
  /** It said in daemon.hello that an ALP agent started it (t-ca1f): refused what only the user may do. */
  agent?: boolean;
  /** The agent's name an agent connection gave in daemon.hello (`principal.agent`, t-1c59): who it is, for the logs; never grants anything. Sticky: the first name stays. */
  agentName?: string;
  /** The client name daemon.hello gave: a gate card answered from alp-paseo* is recorded as paseo, else web. */
  client?: string;
  roots: Set<string>;
  send(message: unknown): void;
  nextId: number;
  pending: Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout; caller: Connection }>;
};
