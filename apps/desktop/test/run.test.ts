import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { run } from '../src/run';
import { isExecutable } from '../src/alp-web';

const scratch = mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'alp-desktop-run-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const env = { PATH: '/usr/bin:/bin' };

describe('run', () => {
  test('collects output and the exit code', async () => {
    const result = await run('/bin/sh', ['-c', 'echo out; echo err >&2; exit 3'], { env, timeout: 5000 });
    expect(result).toMatchObject({ code: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false });
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
