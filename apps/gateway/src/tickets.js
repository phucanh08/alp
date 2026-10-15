// @ts-check
import { createHash, randomBytes } from 'node:crypto';

/**
 * One-time WebSocket tickets (docs/alp/remote-gateway.md §4). A client trades its credential,
 * sent in an Authorization header, for a ticket, then offers the ticket as the WebSocket
 * subprotocol `alp.ticket.<ticket>`: browsers cannot set headers on a WebSocket, and a long-lived
 * secret must not travel in a URL. A ticket lives `ttlMs`, opens one connection, is bound to
 * the Origin that asked for it, and dies with its credential. Only hashes are kept.
 */

const TICKET = /^alpgwt\.[A-Za-z0-9_-]{43}$/;
const key = (/** @type {string} */ ticket) => createHash('sha256').update(ticket, 'utf8').digest('hex');

export class TicketBook {
  /** @type {Map<string, { principal: string, origin: string | null, expiresAt: number }>} */ #tickets = new Map();
  #ttlMs;
  #perPrincipal;
  #total;
  #now;

  /** @param {{ ttlMs?: number, perPrincipal?: number, total?: number, now?: () => number }} [options] */
  constructor({ ttlMs = 30_000, perPrincipal = 16, total = 1024, now = Date.now } = {}) {
    this.#ttlMs = ttlMs;
    this.#perPrincipal = perPrincipal;
    this.#total = total;
    this.#now = now;
  }

  #prune() {
    const now = this.#now();
    for (const [hash, entry] of this.#tickets) if (entry.expiresAt <= now) this.#tickets.delete(hash);
  }

  /**
   * A new ticket for `principal`, or undefined when too many are outstanding.
   * @param {string} principal @param {string | null} origin
   */
  issue(principal, origin) {
    this.#prune();
    let mine = 0;
    for (const entry of this.#tickets.values()) if (entry.principal === principal) mine++;
    if (mine >= this.#perPrincipal || this.#tickets.size >= this.#total) return undefined;
    const ticket = `alpgwt.${randomBytes(32).toString('base64url')}`;
    const expiresAt = this.#now() + this.#ttlMs;
    this.#tickets.set(key(ticket), { principal, origin, expiresAt });
    return { ticket, expiresAt };
  }

  /**
   * The principal of a live ticket presented from the Origin it was issued to; the ticket is spent
   * either way, so a guess or a replay gets one try.
   * @param {unknown} ticket @param {string | null} origin
   */
  consume(ticket, origin) {
    if (typeof ticket !== 'string' || !TICKET.test(ticket)) return undefined;
    const hash = key(ticket);
    const entry = this.#tickets.get(hash);
    this.#tickets.delete(hash);
    if (!entry || entry.expiresAt <= this.#now() || entry.origin !== origin) return undefined;
    return entry.principal;
  }

  /** Drops every ticket of a credential that was revoked or changed. @param {string} principal */
  revoke(principal) {
    for (const [hash, entry] of this.#tickets) if (entry.principal === principal) this.#tickets.delete(hash);
  }

  get size() { this.#prune(); return this.#tickets.size; }
}
