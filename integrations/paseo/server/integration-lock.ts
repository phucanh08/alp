import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rmdir, unlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { bootTime } from '@anhlp/alp-client/index';

type Lock = { pid: number; bootTime: number; startedAt: string; ready: boolean; lockVersion?: number; owner?: string };
type Identity = { owner: string; dev: number; ino: number };

/** Single-host, same PID namespace, private local filesystem only. Never reap the mutation guard. */
export function createIntegrationLock(home: string) {
  const file = path.join(home, 'integrations', 'web.lock');
  const guard = `${file}.reclaim`;
  let phase: 'new' | 'acquiring' | 'owned' | 'retired' = 'new';
  let owned: Identity | undefined;
  const recovery = (reason: string) => new Error(`${reason}. Stop ALL integration processes using this ALP_HOME before manual lock-only recovery of ${file} and ${guard}; see docs/modular-monorepo.md`);

  async function guarded<T>(run: () => Promise<T>): Promise<T> {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 20_000;
    for (;;) {
      try { await mkdir(guard, { mode: 0o700 }); break; }
      catch (error: any) {
        if (error?.code !== 'EEXIST') throw error;
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
      catch (error: any) { throw recovery(error?.code === 'ENOENT' ? 'Integration guard ownership was lost' : `Integration guard token cleanup failed: ${String(error)}`); }
      try { await rmdir(guard); }
      catch (error) { throw recovery(`Integration guard cleanup failed: ${String(error)}`); }
    }
  }

  async function snapshot(): Promise<{ value: any; info: Stats } | undefined> {
    let handle;
    try { handle = await open(file, 'r'); }
    catch (error: any) { if (error?.code === 'ENOENT') return undefined; throw error; }
    try {
      const info = await handle.stat();
      const raw = await handle.readFile('utf8');
      let value: any;
      try { value = JSON.parse(raw); } catch { value = undefined; }
      return { value, info };
    } finally { await handle.close(); }
  }

  function complete(value: any): value is Lock {
    return value && Number.isSafeInteger(value.pid) && value.pid > 0
      && typeof value.bootTime === 'number' && Number.isFinite(value.bootTime) && value.bootTime > 0
      && typeof value.startedAt === 'string' && Number.isFinite(Date.parse(value.startedAt))
      && typeof value.ready === 'boolean'
      && (value.lockVersion === undefined && value.owner === undefined
        || value.lockVersion === 1 && typeof value.owner === 'string' && /^[a-f0-9-]{36}$/.test(value.owner));
  }

  function dead(value: Lock): boolean {
    try { process.kill(value.pid, 0); return false; }
    catch (error: any) {
      if (error?.code !== 'ESRCH') return false; // EPERM and unknown errors never grant takeover.
      // Approximate wall-clock boot metadata is context, never affirmative death evidence.
      if (Math.abs(value.bootTime - bootTime()) > 30) throw recovery('Integration owner boot context is uncertain');
      return true;
    }
  }

  function matches(current: Awaited<ReturnType<typeof snapshot>>): boolean {
    return !!owned && current?.value?.owner === owned.owner
      && current.info.dev === owned.dev && current.info.ino === owned.ino;
  }

  return {
    async acquire(): Promise<{ acquired: boolean; lock: Lock }> {
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
          const value: Lock = { pid: process.pid, bootTime: bootTime(), startedAt: new Date().toISOString(), ready: false, lockVersion: 1, owner: randomUUID() };
          const handle = await open(file, 'wx', 0o600);
          let info: Stats;
          try { await handle.writeFile(JSON.stringify(value)); info = await handle.stat(); }
          finally { await handle.close(); }
          owned = { owner: value.owner!, dev: info.dev, ino: info.ino };
          phase = 'owned';
          return { acquired: true, lock: value };
        });
      } catch (error) { phase = 'retired'; owned = undefined; throw error; }
    },

    async setReady(ready: boolean): Promise<boolean> {
      if (phase !== 'owned') return false;
      return guarded(async () => {
        if (phase !== 'owned') return false;
        const current = await snapshot();
        if (!matches(current)) { phase = 'retired'; owned = undefined; return false; }
        const value = { ...current!.value, ready };
        const tmp = `${file}.${randomUUID()}.tmp`;
        const handle = await open(tmp, 'wx', 0o600);
        let info: Stats;
        try {
          try { await handle.writeFile(JSON.stringify(value)); info = await handle.stat(); }
          finally { await handle.close(); }
          await rename(tmp, file);
          owned = { owner: value.owner, dev: info.dev, ino: info.ino };
          return true;
        } finally { await unlink(tmp).catch((error: any) => { if (error?.code !== 'ENOENT') throw error; }); }
      });
    },

    async release(): Promise<boolean> {
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
