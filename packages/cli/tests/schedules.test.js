import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
test('schedule rejects ambiguous times and incomplete commands before contacting or starting alpd', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'alp-cli-schedule-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const run = args => spawnSync(process.execPath, [CLI, 'schedule', ...args], { env: { ...process.env, ALP_HOME: home }, encoding: 'utf8' });
  for (const args of [
    ['create', '--session', 'root', '--at', '2026-10-21T09:00:00', '--prompt', 'Resume'],
    ['create', '--session', 'root', '--at', '2026-10-21T09:00:00Z'],
    ['create', '--at', '2026-10-21T09:00:00+07:00', '--prompt', 'Resume'],
  ]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /needs --session, --prompt and --at/);
  }
  for (const args of [['show'], ['cancel'], ['list', 'extra'], ['list', '--prompt', 'wrong'], ['create', '--status', 'pending'], ['cron']]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  }
  assert.deepEqual(await readdir(home), [], 'validation creates no daemon or job state');
});
