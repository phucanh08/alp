import { mkdtemp, open, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
  acquirePidLock,
  getPidLockInfo,
  isLocked,
  PidLockError,
  refreshPidLock,
  releasePidLock,
  updatePidLock,
} from "./pid-lock.js";

describe("pid-lock ownership", () => {
  test("writes and releases lock for explicit owner pid", async () => {
    const parent = await mkdtemp(join(tmpdir(), "alp-pid-lock-owner-"));
    const alpHome = join(parent, "home");
    const ownerPid = process.pid + 10_000;

    try {
      await (
        acquirePidLock as unknown as (
          home: string,
          sockPath: string | null,
          options: { ownerPid: number },
        ) => Promise<void>
      )(alpHome, null, { ownerPid });

      if (process.platform !== "win32") {
        expect((await stat(alpHome)).mode & 0o777).toBe(0o700);
      }
      const lock = await getPidLockInfo(alpHome);
      expect(lock?.pid).toBe(ownerPid);
      expect(lock?.listen).toBeNull();
      expect(lock?.heartbeat).toBe(true);

      await (
        updatePidLock as unknown as (
          home: string,
          patch: { listen: string },
          options: { ownerPid: number },
        ) => Promise<void>
      )(alpHome, { listen: "127.0.0.1:6767" }, { ownerPid });

      const updatedLock = await getPidLockInfo(alpHome);
      expect(updatedLock?.listen).toBe("127.0.0.1:6767");

      await (
        releasePidLock as unknown as (home: string, options: { ownerPid: number }) => Promise<void>
      )(alpHome, { ownerPid: ownerPid + 1 });
      const lockAfterWrongOwnerRelease = await getPidLockInfo(alpHome);
      expect(lockAfterWrongOwnerRelease?.pid).toBe(ownerPid);

      await (
        releasePidLock as unknown as (home: string, options: { ownerPid: number }) => Promise<void>
      )(alpHome, { ownerPid });
      const lockAfterOwnerRelease = await getPidLockInfo(alpHome);
      expect(lockAfterOwnerRelease).toBeNull();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("keeps a stale heartbeat lock when the recorded pid is alive without a reachability check", async () => {
    const alpHome = await mkdtemp(join(tmpdir(), "alp-pid-lock-stale-heartbeat-"));
    const replacementOwnerPid = process.pid + 10_000;

    try {
      const pidPath = join(alpHome, "alp.pid");
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: "old-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
          heartbeat: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await expect(isLocked(alpHome)).resolves.toMatchObject({ locked: true });
      await expect(
        acquirePidLock(alpHome, null, { ownerPid: replacementOwnerPid }),
      ).rejects.toThrow("Another alp daemon is already running");

      const lock = await getPidLockInfo(alpHome);
      expect(lock?.pid).toBe(process.pid);
    } finally {
      await rm(alpHome, { recursive: true, force: true });
    }
  });

  test("preserves a stale live desktop heartbeat lock", async () => {
    const alpHome = await mkdtemp(join(tmpdir(), "alp-pid-lock-stale-desktop-heartbeat-"));
    const replacementOwnerPid = process.pid + 10_000;

    try {
      const pidPath = join(alpHome, "alp.pid");
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: "old-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
          heartbeat: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await expect(
        acquirePidLock(alpHome, null, { ownerPid: replacementOwnerPid }),
      ).rejects.toThrow("Another alp daemon is already running");

      const lock = await getPidLockInfo(alpHome);
      expect(lock?.pid).toBe(process.pid);
      expect(lock?.listen).toBe("127.0.0.1:6767");
    } finally {
      await rm(alpHome, { recursive: true, force: true });
    }
  });

  test("keeps a stale live lock written by a pre-heartbeat daemon", async () => {
    const alpHome = await mkdtemp(join(tmpdir(), "alp-pid-lock-legacy-live-"));
    const pidPath = join(alpHome, "alp.pid");

    try {
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: "old-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await expect(
        acquirePidLock(alpHome, null, { ownerPid: process.pid + 10_000 }),
      ).rejects.toThrow("Another alp daemon is already running");

      const lock = await getPidLockInfo(alpHome);
      expect(lock?.pid).toBe(process.pid);
    } finally {
      await rm(alpHome, { recursive: true, force: true });
    }
  });

  test("preserves a stale live legacy desktop lock", async () => {
    const alpHome = await mkdtemp(join(tmpdir(), "alp-pid-lock-legacy-desktop-"));
    const replacementOwnerPid = process.pid + 10_000;
    const pidPath = join(alpHome, "alp.pid");

    try {
      await writeFile(
        pidPath,
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: "old-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
        }),
      );
      const staleTime = new Date(Date.now() - 10 * 60_000);
      await utimes(pidPath, staleTime, staleTime);

      await expect(
        acquirePidLock(alpHome, null, { ownerPid: replacementOwnerPid }),
      ).rejects.toThrow("Another alp daemon is already running");

      const lock = await getPidLockInfo(alpHome);
      expect(lock?.pid).toBe(process.pid);
      expect(lock?.heartbeat).toBeUndefined();
    } finally {
      await rm(alpHome, { recursive: true, force: true });
    }
  });

  test("rejects a heartbeat refresh after another supervisor takes ownership", async () => {
    const alpHome = await mkdtemp(join(tmpdir(), "alp-pid-lock-refresh-owner-"));

    try {
      await acquirePidLock(alpHome, null, { ownerPid: process.pid + 10_000 });

      await expect(refreshPidLock(alpHome, { ownerPid: process.pid })).rejects.toBeInstanceOf(
        PidLockError,
      );
    } finally {
      await rm(alpHome, { recursive: true, force: true });
    }
  });

  test("retries a heartbeat refresh while its owner is rewriting the lock", async () => {
    const alpHome = await mkdtemp(join(tmpdir(), "alp-pid-lock-refresh-rewrite-"));
    const pidPath = join(alpHome, "alp.pid");

    try {
      await acquirePidLock(alpHome, null, { ownerPid: process.pid });
      const lock = await getPidLockInfo(alpHome);
      expect(lock).not.toBeNull();

      const rewriteHandle = await open(pidPath, "r+");
      await rewriteHandle.truncate(0);

      const refresh = refreshPidLock(alpHome, { ownerPid: process.pid });
      await new Promise((resolve) => setTimeout(resolve, 250));
      await rewriteHandle.writeFile(JSON.stringify(lock));
      await rewriteHandle.close();

      await expect(refresh).resolves.toBeUndefined();
    } finally {
      await rm(alpHome, { recursive: true, force: true });
    }
  });

  test("keeps a fresh lock when the recorded pid is alive", async () => {
    const alpHome = await mkdtemp(join(tmpdir(), "alp-pid-lock-fresh-heartbeat-"));

    try {
      await writeFile(
        join(alpHome, "alp.pid"),
        JSON.stringify({
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: "current-host",
          uid: process.getuid?.() ?? 0,
          listen: "127.0.0.1:6767",
          desktopManaged: true,
          heartbeat: true,
        }),
      );

      await expect(
        acquirePidLock(alpHome, null, { ownerPid: process.pid + 10_000 }),
      ).rejects.toThrow("Another alp daemon is already running");

      const lock = await getPidLockInfo(alpHome);
      expect(lock?.pid).toBe(process.pid);
      expect(lock?.listen).toBe("127.0.0.1:6767");
    } finally {
      await rm(alpHome, { recursive: true, force: true });
    }
  });

  test("starts over an empty lock file left by a supervisor killed before writing it", async () => {
    const alpHome = await mkdtemp(join(tmpdir(), "alp-pid-lock-empty-"));
    const ownerPid = process.pid + 10_000;

    try {
      await writeFile(join(alpHome, "alp.pid"), "");

      await expect(getPidLockInfo(alpHome)).resolves.toBeNull();
      await acquirePidLock(alpHome, null, { ownerPid });

      const lock = await getPidLockInfo(alpHome);
      expect(lock?.pid).toBe(ownerPid);
    } finally {
      await rm(alpHome, { recursive: true, force: true });
    }
  });

  test("keeps a lock file whose contents cannot be read as a lock", async () => {
    const alpHome = await mkdtemp(join(tmpdir(), "alp-pid-lock-unparseable-"));
    const pidPath = join(alpHome, "alp.pid");

    try {
      await writeFile(pidPath, JSON.stringify({ pid: "unknown" }));

      await expect(
        acquirePidLock(alpHome, null, { ownerPid: process.pid + 10_000 }),
      ).rejects.toThrow("Cannot read daemon state");

      await expect(readFile(pidPath, "utf-8")).resolves.toBe(JSON.stringify({ pid: "unknown" }));
    } finally {
      await rm(alpHome, { recursive: true, force: true });
    }
  });
});

// alp-rename-keep-start: alp 1.0.0 wrote its lock as paseo.pid.
describe("pid-lock across the paseo.pid → alp.pid rename", () => {
  function legacyLock(startedAt: string) {
    return JSON.stringify({
      pid: process.pid,
      startedAt,
      hostname: "old-host",
      uid: process.getuid?.() ?? 0,
      listen: "127.0.0.1:6767",
      heartbeat: true,
    });
  }

  test("moves an abandoned paseo.pid to alp.pid and takes the lock", async () => {
    const alpHome = await mkdtemp(join(tmpdir(), "alp-pid-lock-legacy-stale-"));
    const ownerPid = process.pid + 10_000;
    try {
      await writeFile(join(alpHome, "paseo.pid"), legacyLock("2000-01-01T00:00:00.000Z"));

      await acquirePidLock(alpHome, null, { ownerPid });

      expect((await getPidLockInfo(alpHome))?.pid).toBe(ownerPid);
      expect(await readdir(alpHome)).toEqual(["alp.pid"]);
    } finally {
      await rm(alpHome, { recursive: true, force: true });
    }
  });

  test("refuses to start beside a running 1.0.0 daemon and leaves its lock where it is", async () => {
    const alpHome = await mkdtemp(join(tmpdir(), "alp-pid-lock-legacy-live-"));
    const contents = legacyLock(new Date().toISOString());
    try {
      await writeFile(join(alpHome, "paseo.pid"), contents);

      await expect(
        acquirePidLock(alpHome, null, { ownerPid: process.pid + 10_000 }),
      ).rejects.toThrow("Another alp daemon is already running");

      expect(await readFile(join(alpHome, "paseo.pid"), "utf8")).toBe(contents);
      expect((await getPidLockInfo(alpHome))?.pid).toBe(process.pid);
    } finally {
      await rm(alpHome, { recursive: true, force: true });
    }
  });

  test("reports a running 1.0.0 daemon without writing anything", async () => {
    const alpHome = await mkdtemp(join(tmpdir(), "alp-pid-lock-legacy-read-"));
    try {
      await writeFile(join(alpHome, "paseo.pid"), legacyLock(new Date().toISOString()));

      await expect(isLocked(alpHome)).resolves.toMatchObject({
        locked: true,
        info: { pid: process.pid },
      });
      expect(await readdir(alpHome)).toEqual(["paseo.pid"]);
    } finally {
      await rm(alpHome, { recursive: true, force: true });
    }
  });

  test("leaves an unreadable paseo.pid in place and starts", async () => {
    const alpHome = await mkdtemp(join(tmpdir(), "alp-pid-lock-legacy-corrupt-"));
    const ownerPid = process.pid + 10_000;
    try {
      await writeFile(join(alpHome, "paseo.pid"), "{not json");

      await expect(getPidLockInfo(alpHome)).resolves.toBeNull();
      await acquirePidLock(alpHome, null, { ownerPid });

      expect((await getPidLockInfo(alpHome))?.pid).toBe(ownerPid);
      expect(await readFile(join(alpHome, "paseo.pid"), "utf8")).toBe("{not json");
    } finally {
      await rm(alpHome, { recursive: true, force: true });
    }
  });
});
// alp-rename-keep-end
