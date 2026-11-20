import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { run } from '../src/run';
import { isExecutable } from '../src/dashboard';

const scratch = mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'alp-desktop-run-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const env = { PATH: '/usr/bin:/bin' };

describe('run', () => {
  test('collects output and the exit code', async () => {
    const result = await run('/bin/sh', ['-c', 'echo out; echo err >&2; exit 3'], { env, timeout: 5000 });
    expect(result).toMatchObject({ code: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false });
  });
  test('a UTF-8 character split across two writes arrives whole', async () => {
    // "é" is C3 A9; the shell writes the two bytes with a pause between, so they reach run as two chunks.
    const result = await run('/bin/sh', ['-c', "printf '\\303'; sleep 0.2; printf '\\251\\n'"], { env, timeout: 5000 });
    expect(result.stdout).toBe('é\n');
  });
  test('a child that ignores SIGTERM is killed at the deadline, and run answers', async () => {
    const started = Date.now();
    const result = await run('/bin/sh', ['-c', "trap '' TERM; echo partial; while :; do sleep 1; done"], { env, timeout: 400, killGroup: true });
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
    expect(result.stdout).toBe('partial\n');
    expect(Date.now() - started).toBeLessThan(2500);
  });
  test('a grandchild holding stdout open does not delay the answer after the child exits', async () => {
    const started = Date.now();
    // The background sleep inherits stdout and keeps it open for 30 s; the shell exits at once.
    const result = await run('/bin/sh', ['-c', 'sleep 30 & echo done; exit 0'], { env, timeout: 10_000, exitGrace: 200 });
    expect(result).toMatchObject({ code: 0, stdout: 'done\n', timedOut: false });
    expect(Date.now() - started).toBeLessThan(3000);
  });
  test('a grandchild holding stdout with a child that never exits still ends at the deadline', async () => {
    const started = Date.now();
    const result = await run('/bin/sh', ['-c', "trap '' TERM; sleep 30 & wait"], { env, timeout: 400, killGroup: true });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(2500);
  });
  test('killGroup: a background job left in the group is stopped after a normal exit', async () => {
    const pidFile = path.join(scratch, 'job.pid');
    // No job control in sh -c: the job stays in the child's group, and its stdio is closed so only
    // the group kill can end it.
    const result = await run('/bin/sh', ['-c', `sleep 30 >/dev/null 2>&1 </dev/null & echo $! > '${pidFile}'; exit 0`], { env, timeout: 5000, killGroup: true });
    expect(result).toMatchObject({ code: 0, timedOut: false });
    const pid = Number(readFileSync(pidFile, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const until = Date.now() + 2000;
    while (alive() && Date.now() < until) await Bun.sleep(20);
    expect(alive()).toBe(false);
  });
  test('without killGroup, a background job is left alone', async () => {
    const pidFile = path.join(scratch, 'job2.pid');
    await run('/bin/sh', ['-c', `sleep 30 >/dev/null 2>&1 </dev/null & echo $! > '${pidFile}'; exit 0`], { env, timeout: 5000 });
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await Bun.sleep(200);
    expect(() => process.kill(pid, 0)).not.toThrow();
    process.kill(pid, 'SIGKILL');
  });
  test('a deadline that falls inside the grace window after the exit is not a timeout', async () => {
    // The child exits at once; a grandchild holds stdout; the deadline (300 ms) comes before the grace (2 s) ends.
    const result = await run('/bin/sh', ['-c', 'sleep 30 & echo done; exit 4'], { env, timeout: 300, exitGrace: 2000, killGroup: true });
    expect(result).toMatchObject({ code: 4, stdout: 'done\n', timedOut: false });
  });
  test('maxBuffer counts bytes, and a cut never splits the characters before it', async () => {
    // "é" is two bytes: 5 bytes keep "éé" and the first byte of the third, which decodes as U+FFFD.
    const result = await run('/bin/sh', ['-c', "printf 'ééé'"], { env, timeout: 5000, maxBuffer: 5 });
    expect(result.stdout).toBe('éé\uFFFD');
    const exact = await run('/bin/sh', ['-c', "printf 'ééé'"], { env, timeout: 5000, maxBuffer: 4 });
    expect(exact.stdout).toBe('éé');
    expect(Buffer.byteLength(exact.stdout)).toBe(4);
  });
  test('a program that does not exist reports the error', async () => {
    const result = await run(path.join(scratch, 'nope'), [], { env, timeout: 2000 });
    expect(result.code).toBeNull();
    expect(result.error?.message).toContain('ENOENT');
  });
});

describe('isExecutable', () => {
  test('a regular executable file only', async () => {
    const file = path.join(scratch, 'alp');
    writeFileSync(file, '#!/bin/sh\n');
    chmodSync(file, 0o755);
    const plain = path.join(scratch, 'plain');
    writeFileSync(plain, 'x');
    chmodSync(plain, 0o644);
    const dir = path.join(scratch, 'dir');
    mkdirSync(dir);
    expect(await isExecutable(file)).toBe(true);
    expect(await isExecutable(plain)).toBe(false);
    expect(await isExecutable(dir)).toBe(false);
    expect(await isExecutable(path.join(scratch, 'missing'))).toBe(false);
  });
});
