/**
 * Keeping the window on a live alp web (docs/alp/desktop.md §3.1). Once an alp web page has loaded,
 * the shell watches it: it asks GET <origin>/readyz every few seconds, and main.ts reports a failed
 * reload and a token the gateway refused (401 from POST /v1/tickets, after `alp web rotate`). Then it
 * runs `alp web --print` again, which starts alp web if it is down, and loads the address it prints.
 *
 * - alpd restarting is not a reason: alp web keeps answering (/readyz 503) and the page reconnects to
 *   its gateway by itself. Only alp web not answering HTTP at all (stopped, crashed, moved port) is.
 * - One recovery at a time: triggers while one is pending or running are dropped (debounce).
 * - Attempts wait 1, 2, 4, 8, 16, then 30 seconds; after `maxAttempts` the shell gives up and shows
 *   the error page, where File › Connect again starts over. The count restarts only after a page has
 *   stayed up for `stableMs`, so an alp web that fails again at once cannot cause a storm.
 * - A token refused again by an address alp still prints is given up at once: reloading it would
 *   only be refused again.
 *
 * Pure apart from the injected dependencies, so tests drive it with fake timers.
 */
import type { Connect } from './alp-web';
import type { AlpWebAddress } from './url';

export type Trigger = 'down' | 'load-failed' | 'token-rejected';
export type ReconnectState = 'idle' | 'watching' | 'waiting' | 'resolving' | 'loading';

export type Timers = {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  now(): number;
};

export type ReconnectDeps = {
  /** Runs `alp web --print` (connectAlpWeb). */
  resolve(): Promise<Connect>;
  /** Whether alp web at `origin` answers HTTP at all (any status, 503 included). */
  probe(origin: string): Promise<boolean>;
  /** Starts loading `address`; the outcome comes back through loaded() or loadFailed(). */
  load(address: AlpWebAddress): void;
  /** Recovery is over without a page: show why (missing alp, alp's error, or `message`). */
  giveUp(result: Connect | undefined, message: string): void;
  timers?: Timers;
};

export type ReconnectOptions = {
  pollMs?: number;
  /** Consecutive failed probes that mean alp web is down (one can be a slow answer). */
  failuresToTrigger?: number;
  backoffMs?: readonly number[];
  maxAttempts?: number;
  stableMs?: number;
};

export const DEFAULTS = {
  pollMs: 3_000,
  failuresToTrigger: 2,
  backoffMs: [1_000, 2_000, 4_000, 8_000, 16_000, 30_000],
  maxAttempts: 8,
  stableMs: 60_000,
} as const;

const realTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export class Reconnector {
  #state: ReconnectState = 'idle';
  #address: AlpWebAddress | undefined;
  /** Bumped by stop() and each new phase; a callback from an older one does nothing. */
  #epoch = 0;
  #timer: unknown;
  #failures = 0;
  #attempts = 0;
  #since = 0;
  #reason: Trigger = 'down';
  readonly #deps: ReconnectDeps;
  readonly #timers: Timers;
  readonly #options: Required<ReconnectOptions>;

  constructor(deps: ReconnectDeps, options: ReconnectOptions = {}) {
    this.#deps = deps;
    this.#timers = deps.timers ?? realTimers;
    this.#options = { ...DEFAULTS, ...options } as Required<ReconnectOptions>;
  }

  get state(): ReconnectState { return this.#state; }
  get attempts(): number { return this.#attempts; }
  /** Whether a failure of an alp web load is this machine's to handle (not an error page's). */
  get active(): boolean { return this.#state !== 'idle'; }

  /** An alp web page finished loading: watch it. */
  loaded(address: AlpWebAddress) {
    // A recovery waiting or asking alp goes on: a page that loaded meanwhile (a reload) does not
    // say alp web is back, and the attempt checks that itself.
    if (this.#state === 'waiting' || this.#state === 'resolving') return;
    const recovered = this.#state === 'loading';
    this.#enter('watching');
    this.#address = address;
    this.#failures = 0;
    this.#since = this.#timers.now();
    // A manual connect starts from zero; a recovery keeps its count until the page proves stable.
    if (!recovered) this.#attempts = 0;
    this.#schedulePoll();
  }

  /** Stop everything (Connect again, the window closed, a bundled page shown). */
  stop() {
    this.#enter('idle');
    this.#address = undefined;
    this.#failures = 0;
    this.#attempts = 0;
  }

  /** Something says alp web is gone or the page lost it. Ignored unless a page is watched or loading. */
  trigger(reason: Trigger) {
    if (this.#state === 'watching') {
      if (this.#timers.now() - this.#since >= this.#options.stableMs) this.#attempts = 0;
      this.#reason = reason;
      this.#scheduleAttempt();
    } else if (this.#state === 'loading' && reason !== 'down') {
      // The load this machine started failed (or its page was refused): next attempt, same count.
      this.#reason = reason;
      this.#scheduleAttempt();
    }
    // waiting or resolving: a recovery is already under way. idle: nothing is watched.
  }

  loadFailed() { this.trigger('load-failed'); }

  #enter(state: ReconnectState) {
    this.#state = state;
    this.#epoch++;
    if (this.#timer !== undefined) this.#timers.clear(this.#timer);
    this.#timer = undefined;
  }

  #schedulePoll() {
    const epoch = this.#epoch;
    this.#timer = this.#timers.set(() => void this.#poll(epoch), this.#options.pollMs);
  }

  async #poll(epoch: number) {
    const address = this.#address;
    if (epoch !== this.#epoch || !address) return;
    let up = false;
    try { up = await this.#deps.probe(address.origin); } catch { up = false; }
    if (epoch !== this.#epoch) return;
    this.#failures = up ? 0 : this.#failures + 1;
    if (this.#failures >= this.#options.failuresToTrigger) this.trigger('down');
    else this.#schedulePoll();
  }

  #scheduleAttempt() {
    if (this.#attempts >= this.#options.maxAttempts) {
      this.#giveUp(undefined, 'ALP web stopped answering, and reconnecting did not work. Start ALP, then choose Connect again.');
      return;
    }
    const { backoffMs } = this.#options;
    const delay = backoffMs[Math.min(this.#attempts, backoffMs.length - 1)] ?? 0;
    this.#enter('waiting');
    const epoch = this.#epoch;
    this.#timer = this.#timers.set(() => void this.#attempt(epoch), delay);
  }

  async #attempt(epoch: number) {
    if (epoch !== this.#epoch) return;
    this.#enter('resolving');
    const mine = this.#epoch;
    this.#attempts++;
    let result: Connect;
    try { result = await this.#deps.resolve(); } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (mine !== this.#epoch) return;
    if (!result.ok) {
      // Missing alp will not fix itself; alp's own error might (alp web still starting).
      if ('missing' in result || this.#attempts >= this.#options.maxAttempts) this.#giveUp(result, '');
      else this.#scheduleAttempt();
      return;
    }
    const same = result.address.url === this.#address?.url;
    if (same && this.#reason === 'token-rejected') {
      this.#giveUp(undefined, 'ALP web refused its own access token. Run `alp web rotate`, then choose Connect again.');
      return;
    }
    if (same && this.#reason === 'down') {
      // alp web is back on the same address and token: the page reconnects to it by itself.
      let up = false;
      try { up = await this.#deps.probe(result.address.origin); } catch { up = false; }
      if (mine !== this.#epoch) return;
      if (up) {
        this.#enter('watching');
        this.#failures = 0;
        this.#since = this.#timers.now();
        this.#schedulePoll();
        return;
      }
    }
    this.#enter('loading');
    this.#address = result.address;
    this.#deps.load(result.address);
  }

  #giveUp(result: Connect | undefined, message: string) {
    this.stop();
    this.#deps.giveUp(result, message);
  }
}
