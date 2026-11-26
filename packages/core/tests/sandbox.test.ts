import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { claudeSandboxAvailable } from '@anhlp/alp-core/sandbox';

/** Sets environment variables for one test and puts the old values back after it. */
function withEnv(t: TestContext, values: Record<string, string | undefined>) {
  const old = Object.fromEntries(Object.keys(values).map(name => [name, process.env[name]]));
  t.after(() => { for (const [name, value] of Object.entries(old)) if (value === undefined) delete process.env[name]; else process.env[name] = value; });
  for (const [name, value] of Object.entries(values)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
}

test('ALP_CLAUDE_SANDBOX=0 and =1 decide the Claude sandbox whatever the host has', t => {
  withEnv(t, { ALP_CLAUDE_SANDBOX: '0' });
  assert.equal(claudeSandboxAvailable(), false);
  process.env.ALP_CLAUDE_SANDBOX = '1';
  assert.equal(claudeSandboxAvailable(), true);
});

test('without the override the host decides: Seatbelt on macOS, bwrap and socat on PATH on Linux, nothing elsewhere', async t => {
  withEnv(t, { ALP_CLAUDE_SANDBOX: undefined });
  if (process.platform === 'darwin') {
    assert.equal(claudeSandboxAvailable(), existsSync('/usr/bin/sandbox-exec'));
    return;
  }
  if (process.platform !== 'linux') {
    assert.equal(claudeSandboxAvailable(), false);
    return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'alp-sandbox-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  await mkdir(bin);
  withEnv(t, { PATH: bin });
  assert.equal(claudeSandboxAvailable(), false, 'neither tool');
  await writeFile(path.join(bin, 'bwrap'), '');
  assert.equal(claudeSandboxAvailable(), false, 'bwrap without socat');
  await writeFile(path.join(bin, 'socat'), '');
  assert.equal(claudeSandboxAvailable(), true, 'both tools');
});
