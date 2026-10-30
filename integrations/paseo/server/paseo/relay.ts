import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { SessionInboundMessage, SessionOutboundMessage } from '@getpaseo/protocol/messages';
import { exportPublicKey, exportSecretKey, generateKeyPair, importPublicKey, importSecretKey, type KeyPair } from '@getpaseo/relay/e2ee';
import { setWebRelay } from '@anhlp/alp-core/user-settings';
import { NOT_IMPLEMENTED, type Handler, type Outbound } from './gateway.js';
import { startRelayTransport, type RelaySocketLike, type RelayTransportController, type RelayWebSocketFactory } from './relay-transport.js';

/**
 * Paseo's relay for alpd (D32, ALPD §64): with it on, alpd keeps a socket open to the relay, and
 * Paseo's app on another device, paired by a link or QR code carrying alpd's public key, reaches
 * alpd through it, end to end encrypted. Each device still signs in with alpd's token, which the
 * pairing link does not carry. Off until the user turns it on.
 */

export const DEFAULT_RELAY_ENDPOINT = 'relay.paseo.sh:443';
/** Paseo's app opens a link of this site with an #offer= fragment; the phone's camera hands it over. */
const PAIRING_APP_URL = 'https://app.paseo.sh';
const KEYPAIR_FILE = 'relay-keypair.json';

type Inbound<T extends SessionInboundMessage['type']> = Extract<SessionInboundMessage, { type: T }>;
export type RelaySettings = { enabled?: boolean; endpoint?: string; useTls?: boolean };

/** alpd's relay key pair, made once and kept beside its token; a new one unpairs every device. */
export async function relayKeyPair(home: string): Promise<{ keyPair: KeyPair; publicKeyB64: string }> {
  const file = path.join(home, KEYPAIR_FILE);
  try {
    const kept = JSON.parse(await readFile(file, 'utf8'));
    if (kept?.v === 2 && typeof kept.publicKeyB64 === 'string' && typeof kept.secretKeyB64 === 'string') {
      const keyPair = { publicKey: importPublicKey(kept.publicKeyB64), secretKey: importSecretKey(kept.secretKeyB64) };
      return { keyPair, publicKeyB64: exportPublicKey(keyPair.publicKey) };
    }
  } catch {}
  const keyPair = generateKeyPair();
  const publicKeyB64 = exportPublicKey(keyPair.publicKey);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, JSON.stringify({ v: 2, publicKeyB64, secretKeyB64: exportSecretKey(keyPair.secretKey) }, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, file);
  return { keyPair, publicKeyB64 };
}

/** The link Paseo's app pairs with: `#offer=` and the offer, base64url JSON (Paseo's ConnectionOfferV2). */
export function pairingUrl(offer: { serverId: string; daemonPublicKeyB64: string; endpoint: string; useTls: boolean }) {
  const json = JSON.stringify({ v: 2, serverId: offer.serverId, daemonPublicKeyB64: offer.daemonPublicKeyB64, relay: { endpoint: offer.endpoint, useTls: offer.useTls } });
  return `${PAIRING_APP_URL}/#offer=${Buffer.from(json, 'utf8').toString('base64url')}`;
}

export function createRelay({ home, serverId, attach, initial, log = () => {}, createWebSocket }: {
  home?: string;
  serverId: () => string;
  /** Hands a device's decrypted socket to the gateway, which asks it for the token like any other. */
  attach: (socket: RelaySocketLike) => void;
  initial?: RelaySettings;
  log?: (message: string) => void;
  createWebSocket?: RelayWebSocketFactory;
}) {
  const endpoint = initial?.endpoint ?? DEFAULT_RELAY_ENDPOINT;
  const settings = { enabled: initial?.enabled === true, endpoint, useTls: initial?.useTls ?? endpoint.endsWith(':443') };
  let transport: RelayTransportController | undefined;
  let starting: Promise<void> | undefined;

  async function start() {
    if (!settings.enabled || transport || !home || !serverId()) return;
    starting ??= relayKeyPair(home).then(({ keyPair }) => {
      if (!settings.enabled || transport) return;
      transport = startRelayTransport({ log, attachSocket: attach, relayEndpoint: settings.endpoint, relayUseTls: settings.useTls, serverId: serverId(), daemonKeyPair: keyPair, createWebSocket });
    }).finally(() => { starting = undefined; });
    await starting;
  }

  async function stop() {
    await starting;
    const current = transport;
    transport = undefined;
    await current?.stop();
  }

  return {
    start,
    stop,
    get connected() { return transport?.connected ?? false; },
    /** As Paseo's daemon.get_status and config report it. */
    config() {
      return { enabled: settings.enabled, endpoint: settings.endpoint, publicEndpoint: settings.endpoint, useTls: settings.useTls, publicUseTls: settings.useTls };
    },
    /** Turns the relay on or off now, and keeps the choice in settings.json. */
    async setEnabled(enabled: boolean) {
      if (!home) throw new Error('No ALP home to keep the relay setting in');
      if (enabled !== settings.enabled) await setWebRelay(home, { enabled });
      settings.enabled = enabled;
      if (enabled) await start(); else await stop();
    },
    /** The pairing link, or none while the relay is off. */
    async offer() {
      if (!settings.enabled || !home) return { url: null, relayEnabled: false };
      const { publicKeyB64 } = await relayKeyPair(home);
      return { url: pairingUrl({ serverId: serverId(), daemonPublicKeyB64: publicKeyB64, endpoint: settings.endpoint, useTls: settings.useTls }), relayEnabled: true };
    },
  };
}

export type Relay = ReturnType<typeof createRelay>;

/**
 * The daemon's config and status as Paseo's app reads and changes them: the relay is ALP's; the
 * rest are Paseo's defaults (no Paseo MCP tools, no browser tools; ALP's own plugin runs). A change
 * to anything but the relay answers "in development".
 */
export function createDaemonConfig({ relay, providers, serverId, broadcast, inDevelopment, version, listen, startedAt }: {
  relay: Relay;
  /** The library's ACP providers (providers.ts, ALPD §65). */
  providers?: { config(): Promise<Record<string, unknown>>; apply(patch?: Record<string, Record<string, unknown>>, remove?: string[]): Promise<void> };
  serverId: () => string;
  broadcast: (message: Outbound) => void;
  inDevelopment: () => Promise<string>;
  version: string;
  listen: () => string | null;
  startedAt: string;
}) {
  const config = async () => ({
    relay: { enabled: relay.config().enabled },
    mcp: { enabled: false, injectIntoAgents: false }, browserTools: { enabled: false }, providers: await providers?.config() ?? {}, metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false, enableTerminalAgentHooks: false, appendSystemPrompt: '', pluginsEnabled: true,
  });

  const handlers: Record<string, Handler> = {
    get_daemon_config_request: async (message: Inbound<'get_daemon_config_request'>) =>
      ({ type: 'get_daemon_config_response', payload: { requestId: message.requestId, config: await config() as any } }) satisfies SessionOutboundMessage,

    set_daemon_config_request: async (message: Inbound<'set_daemon_config_request'>) => {
      const { relay: relayPatch, providers: providersPatch, removeProviders, ...rest } = (message.config ?? {}) as { relay?: { enabled?: unknown }; providers?: Record<string, Record<string, unknown>>; removeProviders?: string[] } & Record<string, unknown>;
      if (Object.keys(rest).length || ((providersPatch || removeProviders) && !providers)) throw Object.assign(new Error(await inDevelopment()), { code: NOT_IMPLEMENTED });
      if (relayPatch?.enabled !== undefined && typeof relayPatch.enabled !== 'boolean') throw new Error('relay.enabled must be true or false');
      if (providersPatch || removeProviders) await providers!.apply(providersPatch, removeProviders);
      if (typeof relayPatch?.enabled === 'boolean') await relay.setEnabled(relayPatch.enabled);
      const current = await config();
      if (relayPatch || providersPatch || removeProviders) broadcast({ type: 'status', payload: { status: 'daemon_config_changed', config: current } } as Outbound);
      return { type: 'set_daemon_config_response', payload: { requestId: message.requestId, config: current as any } } satisfies SessionOutboundMessage;
    },

    'daemon.get_status.request': (message: Inbound<'daemon.get_status.request'>) => ({
      type: 'daemon.get_status.response',
      payload: { requestId: message.requestId, serverId: serverId(), version, pid: process.pid, nodePath: process.execPath /* alp-allow-execpath: reported, never spawned */, startedAt, listen: listen(), relay: relay.config(), providers: [] },
    }),

    'daemon.get_pairing_offer.request': async (message: Inbound<'daemon.get_pairing_offer.request'>) => {
      const offer = await relay.offer();
      return { type: 'daemon.get_pairing_offer.response', payload: { requestId: message.requestId, url: offer.url ?? '', qr: null, relayEnabled: offer.relayEnabled } } satisfies SessionOutboundMessage;
    },
  };

  return { handlers, features: { daemonStatusRpc: true, relayConfig: true } };
}
