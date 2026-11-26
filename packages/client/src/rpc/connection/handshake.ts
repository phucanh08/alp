import { PROTOCOL_VERSION } from '@anhlp/alp-protocol';
import type { RequestOptions } from '../client.ts';

/** The daemon.hello capability a process an ALP agent started announces. */
export const AGENT_CAPABILITY = 'principal.agent';

/** @typedef {{ name: string, version: string }} ClientInfo */
export type ClientInfo = { name: string, version: string };

/**
 * The version handshake every ALP connection starts with (plans/reference/ALPD.md §3): alpd
 * answers nothing else before it. Shared by the Node `connect` and portable clients, so a change
 * to the handshake (Task 06) lands in one place.
 * @param {{ request(method: string, params?: unknown, options?: import('../client.js').RequestOptions): Promise<any> }} client
 * @param {ClientInfo} [info]
 * @param {import('../client.js').RequestOptions} [options]
 * @param {{ agent?: boolean }} [principal] `agent`: an ALP agent started this process (the Node entry reads ALP_AGENT_SESSION).
 * @returns {Promise<{ protocolVersion: number } & Record<string, unknown>>}
 */
export function hello(client: { request(method: string, params?: unknown, options?: RequestOptions): Promise<any> /* any: the caller's request result type */ }, info: ClientInfo = { name: 'alp', version: '0' }, options?: RequestOptions, { agent = false }: { agent?: boolean } = {}): Promise<{ protocolVersion: number } & Record<string, unknown>> {
  // A process an ALP agent started says so (t-ca1f): alpd then refuses it what only the user may do.
  return client.request('daemon.hello', { protocolVersion: PROTOCOL_VERSION, client: info, ...(agent ? { capabilities: [AGENT_CAPABILITY] } : {}) }, options);
}
