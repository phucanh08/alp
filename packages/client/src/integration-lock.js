import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { assertIntegrationName, bootTime } from './index.js';

/**
 * @typedef {{ pid: number, bootTime: number, startedAt: string, ready: boolean, lockVersion?: number, owner?: string }} IntegrationLockRecord
 * @typedef {{ owner: string, dev: number, ino: number }} Identity
 * @typedef {{ value: any, info: import('node:fs').Stats }} Snapshot
 * @typedef {{
 *   acquire(): Promise<{ acquired: boolean, lock: IntegrationLockRecord }>,
 *   setReady(ready: boolean): Promise<boolean>,
 *   release(): Promise<boolean>,
 * }} IntegrationLock
 */

/**
 * The single-owner lock of one integration service, at `<home>/integrations/<name>.lock`, with its
 * mutation guard `<name>.lock.reclaim`. Each instance is single-use: acquire once, then setReady and
 * release while it owns the lock.
 *
 * Single-host, same PID namespace, private local filesystem only. Never reap the mutation guard.
 * @param {string} home the ALP_HOME the integration runs under
 * @param {string} name the integration name, for example `web`
 * @returns {IntegrationLock}
 */
export function createIntegrationLock(home, name) {
  const file = path.join(home, 'integrations', `${assertIntegrationName(name)}.lock`);
  const guard = `${file}.reclaim`;
  /** @type {'new' | 'acquiring' | 'owned' | 'retired'} */
  let phase = 'new';
  /** @type {Identity | undefined} */
  let owned;
  /** @param {string} reason */
  const recovery = reason => new Error(`${reason}. Stop ALL integration processes using this ALP_HOME before manual lock-only recovery of ${file} and ${guard}; see docs/modular-monorepo.md`);

  /**
   * @template T
   * @param {() => Promise<T>} run
   * @returns {Promise<T>}
   */
  async function guarded(run) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 20_000;
    for (;;) {
      try { await mkdir(guard, { mode: 0o700 }); break; }
      catch (error) {
        if (/** @type {any} */ (error)?.code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw recovery('Integration mutation guard remains busy or abandoned');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    const token = path.join(guard, `owner-${process.pid}-${randomUUID()}`);
    // If token initialization/close fails, leave the guard: no speculative cleanup of shared paths.
    try {
      const handle = await open(token, 'wx', 0o600);
      await handle.close();
    } catch (error) { throw recovery(`Integration guard initialization failed: ${String(error)}`); }
    try { return await run(); }
    finally {
      // Only this successful mkdir owner finalizes, once. Missing token may mean a replacement
      // generation: never rmdir in that case. No contender removes any other owner's token.
      try { await unlink(token); }
      catch (error) { throw recovery(/** @type {any} */ (error)?.code === 'ENOENT' ? 'Integration guard ownership was lost' : `Integration guard token cleanup failed: ${String(error)}`); }
      try { await rmdir(guard); }
      catch (error) { throw recovery(`Integration guard cleanup failed: ${String(error)}`); }
    }
  }

  /** @returns {Promise<Snapshot | undefined>} */
  async function snapshot() {
    let handle;
    try { handle = await open(file, 'r'); }
    catch (error) { if (/** @type {any} */ (error)?.code === 'ENOENT') return undefined; throw error; }
    try {
      const info = await handle.stat();
      const raw = await handle.readFile('utf8');
      let value;
      try { value = JSON.parse(raw); } catch { value = undefined; }
      return { value, info };
    } finally { await handle.close(); }
  }

  /**
   * @param {any} value
   * @returns {value is IntegrationLockRecord}
   */
  function complete(value) {
    return value && Number.isSafeInteger(value.pid) && value.pid > 0
      && typeof value.bootTime === 'number' && Number.isFinite(value.bootTime) && value.bootTime > 0
      && typeof value.startedAt === 'string' && Number.isFinite(Date.parse(value.startedAt))
      && typeof value.ready === 'boolean'
      && (value.lockVersion === undefined && value.owner === undefined
        || value.lockVersion === 1 && typeof value.owner === 'string' && /^[a-f0-9-]{36}$/.test(value.owner));
  }

  /**
   * @param {IntegrationLockRecord} value
   * @returns {boolean}
   */
  function dead(value) {
    try { process.kill(value.pid, 0); return false; }
    catch (error) {
      if (/** @type {any} */ (error)?.code !== 'ESRCH') return false; // EPERM and unknown errors never grant takeover.
      // Approximate wall-clock boot metadata is context, never affirmative death evidence.
      if (Math.abs(value.bootTime - bootTime()) > 30) throw recovery('Integration owner boot context is uncertain');
      return true;
    }
  }

  /**
   * @param {Snapshot | undefined} current
   * @returns {boolean}
   */
  function matches(current) {
    return !!owned && current?.value?.owner === owned.owner
      && current.info.dev === owned.dev && current.info.ino === owned.ino;
  }

  return {
    async acquire() {
      if (phase !== 'new') throw new Error('Integration lock instance has already been used');
      phase = 'acquiring';
      try {
        return await guarded(async () => {
          const current = await snapshot();
          if (current) {
            if (!complete(current.value)) throw recovery('Integration lock is malformed, incomplete or unsupported');
            if (!dead(current.value)) { phase = 'retired'; return { acquired: false, lock: current.value }; }
            await unlink(file);
          }
          /** @type {IntegrationLockRecord & { owner: string }} */
          const value = { pid: process.pid, bootTime: bootTime(), startedAt: new Date().toISOString(), ready: false, lockVersion: 1, owner: randomUUID() };
          const handle = await open(file, 'wx', 0o600);
          let info;
          try { await handle.writeFile(JSON.stringify(value)); info = await handle.stat(); }
          finally { await handle.close(); }
          owned = { owner: value.owner, dev: info.dev, ino: info.ino };
          phase = 'owned';
          return { acquired: true, lock: value };
        });
      } catch (error) { phase = 'retired'; owned = undefined; throw error; }
    },

    async setReady(ready) {
      if (phase !== 'owned') return false;
      return guarded(async () => {
        if (phase !== 'owned') return false;
        const current = await snapshot();
        if (!current || !matches(current)) { phase = 'retired'; owned = undefined; return false; }
        const value = { ...current.value, ready };
        const tmp = `${file}.${randomUUID()}.tmp`;
        const handle = await open(tmp, 'wx', 0o600);
        let info;
        try {
          try { await handle.writeFile(JSON.stringify(value)); info = await handle.stat(); }
          finally { await handle.close(); }
          await rename(tmp, file);
          owned = { owner: value.owner, dev: info.dev, ino: info.ino };
          return true;
        } finally { await unlink(tmp).catch(error => { if (error?.code !== 'ENOENT') throw error; }); }
      });
    },

    async release() {
      if (phase !== 'owned') return false;
      return guarded(async () => {
        if (phase !== 'owned') return false;
        const current = await snapshot();
        const ours = matches(current);
        phase = 'retired'; owned = undefined;
        if (!ours) return false;
        await unlink(file);
        return true;
      });
    },
  };
}
