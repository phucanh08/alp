import net from 'node:net';

import { createSocketTransport } from './ipc.ts';
import { assertPrivateSocket } from '../daemon/paths.ts';
import { AlpRpcClient } from '../rpc/client.ts';
import { hello } from '../rpc/connection/handshake.ts';
import type { Socket } from 'node:net';
import type { AttachmentLimits, TerminalLimits } from '@anhlp/alp-protocol';

/** The options of the socket transport (maxFrame, maxBufferedBytes). */
export type SocketTransportOptions = NonNullable<Parameters<typeof createSocketTransport>[1]>;
/** The options of AlpClient and connect: the RPC client's and the socket transport's. */
export type AlpClientOptions = NonNullable<ConstructorParameters<typeof AlpRpcClient>[1]> & SocketTransportOptions;

/**
 * One JSON-RPC 2.0 connection to alpd over a Unix socket or named pipe; events arrive as `event`
 * notifications. The engine is the portable AlpRpcClient; this keeps the socket constructor the
 * CLI, alpd's tests and the Paseo plugin use.
 */
export class AlpClient extends AlpRpcClient {
  /** Host features captured by connect's handshake. */
  capabilities: readonly string[] = [];
  /** Limits captured by connect's handshake. */
  attachmentLimits: AttachmentLimits | undefined;
  promptImageLimits: { readonly maxCount: number; readonly maxBytes: number; readonly maxTotalBytes: number } | undefined;
  terminalLimits: TerminalLimits | undefined;
  /** @param socket a connected or connecting socket; the client owns it */
  constructor(socket: Socket, { maxFrame, maxBufferedBytes, ...options }: AlpClientOptions = {}) {
    super(createSocketTransport(socket, { maxFrame, maxBufferedBytes }), { maxFrame, ...options });
  }
}

/** A socket to alpd, once it is checked to be private to this user (the IPC checks above). */
async function openSocket(socketPath: string): Promise<Socket> {
  await assertPrivateSocket(socketPath);
  return (new Promise((resolve, reject) => {
    const candidate = net.createConnection(socketPath);
    candidate.once('connect', () => { candidate.off('error', reject); resolve(candidate); });
    candidate.once('error', reject);
  }));
}

/**
 * The transport to alpd's socket without the handshake, for an AlpRpcClient or a reconnecting
 * client whose onConnect runs `hello`. `connect` is this plus `hello`.
 */
export async function connectSocket(socketPath: string, options?: SocketTransportOptions) {
  return createSocketTransport(await openSocket(socketPath), options);
}

/** Connects and performs the version handshake. */
export async function connect(socketPath: string, client: { name: string, version: string } = { name: 'alp', version: '0' }, options: AlpClientOptions = {}): Promise<AlpClient> {
  const connection = new AlpClient(await openSocket(socketPath), options);
  try {
    const greeting = await hello(connection, client, undefined, { agent: typeof process.env.ALP_AGENT_SESSION === 'string' && process.env.ALP_AGENT_SESSION !== '' });
    connection.capabilities = Object.freeze(Array.isArray(greeting.capabilities) ? greeting.capabilities.filter((value: unknown): value is string => typeof value === 'string') : []);
    if (greeting.attachmentLimits && typeof greeting.attachmentLimits === 'object') {
      connection.attachmentLimits = Object.freeze({ ...greeting.attachmentLimits }) as AttachmentLimits;
    }
    if (greeting.promptImageLimits && typeof greeting.promptImageLimits === 'object') {
      connection.promptImageLimits = Object.freeze({ ...greeting.promptImageLimits }) as { readonly maxCount: number; readonly maxBytes: number; readonly maxTotalBytes: number };
    }
    if (greeting.terminalLimits && typeof greeting.terminalLimits === 'object') {
      connection.terminalLimits = Object.freeze({ ...greeting.terminalLimits }) as TerminalLimits;
    }
  } catch (error) {
    connection.close();
    throw error;
  }
  return connection;
}
