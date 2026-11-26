// The fail-closed ALP home guard of the alpd and persistence lanes (t-cad9). Every case uses only
// scratch directories made here: a fake account home with a fake .alp, protected through
// ALP_TEST_PROTECT_HOME (which can only add protection). No case names the real home or links into
// it. The lane cases run each lane with its CLI replaced by a stub that starts nothing and only
// records that it was called, so a guard that leaks shows up as a record, not as a started alpd.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { teardown } from '../support/teardown.ts';
import { HomeGuardError, checkScratchHome, resolveDeep } from '../e2e/home-guard.mjs';

const here = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'e2e');

function scene(t) {
  const defer = teardown(t);
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'home-guard-')));
  defer(() => rmSync(base, { recursive: true, force: true }));
  const fakeHome = path.join(base, 'home');
  const fakeAlp = path.join(fakeHome, '.alp');
  mkdirSync(path.join(fakeAlp, 'teams'), { recursive: true });
  const scratch = path.join(base, 'scratch');
  mkdirSync(scratch);
  // The 18:02 shape: a symlink in scratch that points at the (fake) user ALP home.
  const link = path.join(scratch, 'link-to-alp');
  symlinkSync(fakeAlp, link);
  const env = { ALP_TEST_PROTECT_HOME: fakeHome };
  return { defer, base, fakeHome, fakeAlp, scratch, link, env };
}

const refuses = (candidate, env, pattern) => assert.throws(() => checkScratchHome(candidate, env), error => error instanceof HomeGuardError && (!pattern || pattern.test(error.message)));

test('the incident: a missing child under a symlink into the user ALP home is refused', t => {
  const { link, env } = scene(t);
  refuses(path.join(link, 'sub'), env, /user's ALP home/);
  refuses(path.join(link, 'sub', 'deeper'), env, /user's ALP home/);
  refuses(link, env, /user's ALP home/);
});

test('the user ALP home, anything inside it and anything holding it are refused', t => {
  const { fakeHome, fakeAlp, env } = scene(t);
  refuses(fakeAlp, env);
  refuses(path.join(fakeAlp, 'teams'), env);
  refuses(path.join(fakeAlp, 'not', 'yet'), env);
  refuses(fakeHome, env);
  refuses(path.dirname(fakeHome), env);
  if (process.platform === 'darwin') refuses(path.join(fakeHome, '.ALP', 'x'), env);
});

test('inside the user home only an explicit scratch root is allowed', t => {
  const { fakeHome, env } = scene(t);
  const inHome = path.join(fakeHome, 'work', 'alp-home');
  refuses(inHome, env, /inside the user's home/);
  mkdirSync(path.join(fakeHome, 'work'));
  assert.equal(checkScratchHome(inHome, { ...env, ALP_TEST_SCRATCH_ROOT: path.join(fakeHome, 'work') }), inHome);
  refuses(inHome, { ...env, ALP_TEST_SCRATCH_ROOT: path.join(fakeHome, 'elsewhere') }, /inside the user's home/);
  // A scratch root cannot open the ALP home or the whole home.
  refuses(path.join(fakeHome, '.alp', 'x'), { ...env, ALP_TEST_SCRATCH_ROOT: path.join(fakeHome, '.alp') });
  refuses(path.join(fakeHome, 'work', 'y'), { ...env, ALP_TEST_SCRATCH_ROOT: fakeHome }, /ALP_TEST_SCRATCH_ROOT/);
});

test('a dangling symlink is refused, not carried as a plain name', t => {
  const { scratch, fakeAlp, env } = scene(t);
  const dangling = path.join(scratch, 'dangling');
  symlinkSync(path.join(fakeAlp, 'sub-not-made'), dangling);
  refuses(dangling, env, /dangling or broken/);
  refuses(path.join(dangling, 'child'), env);
});

test('any resolution error refuses: loop, unreadable ancestor, file as ancestor, relative or empty path', t => {
  const { defer, scratch, env } = scene(t);
  const loop = path.join(scratch, 'loop');
  symlinkSync(loop, loop);
  refuses(path.join(loop, 'x'), env);
  const file = path.join(scratch, 'file');
  writeFileSync(file, '');
  refuses(path.join(file, 'x'), env);
  refuses('relative/home', env, /absolute/);
  refuses('', env);
  if (process.getuid?.() !== 0 && process.platform !== 'win32') {
    const locked = path.join(scratch, 'locked');
    mkdirSync(path.join(locked, 'inner'), { recursive: true });
    chmodSync(locked, 0o000);
    defer(() => chmodSync(locked, 0o755));
    refuses(path.join(locked, 'inner', 'home'), env, /cannot resolve/);
  }
});

test('a protected home that cannot be read refuses everything', t => {
  const { scratch, base } = scene(t);
  const file = path.join(base, 'not-a-dir');
  writeFileSync(file, '');
  refuses(path.join(scratch, 'ok'), { ALP_TEST_PROTECT_HOME: path.join(file, 'home') });
});

test('a scratch home outside every protected home is accepted and resolved', t => {
  const { scratch, env } = scene(t);
  assert.equal(checkScratchHome(path.join(scratch, 'new', 'home'), env), path.join(scratch, 'new', 'home'));
  assert.equal(resolveDeep(path.join(scratch, 'a', '..', 'b')), path.join(scratch, 'b'));
});

// Each lane, run as the user would, with ALP_TEST_CLI a stub: the guard must exit 2 and the stub must
// never have been called. PATH holds only node's directory, and the provider binaries name a missing path.
for (const lane of ['alpd-e2e.mjs', 'persistence-e2e.mjs']) {
  test(`${lane} refuses before calling its CLI`, t => {
    const { scratch, link, fakeHome, env: protect } = scene(t);
    const calls = path.join(scratch, 'cli-calls.txt');
    const stub = path.join(scratch, 'stub-alp');
    writeFileSync(stub, `#!/bin/sh\necho "$@" >> '${calls}'\nexit 97\n`, { mode: 0o755 });
    const missing = path.join(scratch, 'no-such-provider');
    const env = {
      PATH: path.dirname(process.execPath), ...protect, ALP_TEST_CLI: stub,
      ALP_CODEX_BIN: missing, ALP_CLAUDE_BIN: missing, ALP_ANTIGRAVITY_BIN: missing,
      HOME: fakeHome,
      // alpd-e2e takes ALP_HOME; persistence-e2e makes its own home under TMPDIR. Both point into the fake .alp.
      ALP_HOME: path.join(link, 'sub'), TMPDIR: link,
    };
    const run = spawnSync(process.execPath, [path.join(here, lane)], { cwd: scratch, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(run.status, 2, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, /Refusing to run this lane/);
    assert.equal(existsSync(calls), false, existsSync(calls) ? `the stub CLI was called: ${readFileSync(calls, 'utf8')}` : '');
    assert.equal(existsSync(path.join(link, 'sub')), false, 'nothing was made in the fake ALP home');
    assert.equal(existsSync(path.join(scratch, '.alp-test')), false);
  });
}

test('the stub check is live: a scratch ALP_HOME passes the alpd lane guard and reaches the stub', t => {
  const { scratch, fakeHome, env: protect } = scene(t);
  const calls = path.join(scratch, 'cli-calls.txt');
  const stub = path.join(scratch, 'stub-alp');
  writeFileSync(stub, `#!/bin/sh\necho "$@" >> '${calls}'\nexit 97\n`, { mode: 0o755 });
  const missing = path.join(scratch, 'no-such-provider');
  const env = {
    PATH: path.dirname(process.execPath), ...protect, ALP_TEST_CLI: stub,
    ALP_CODEX_BIN: missing, ALP_CLAUDE_BIN: missing, ALP_ANTIGRAVITY_BIN: missing,
    HOME: fakeHome, ALP_HOME: path.join(scratch, 'alp-home'), TMPDIR: scratch,
  };
  const run = spawnSync(process.execPath, [path.join(here, 'alpd-e2e.mjs')], { cwd: scratch, env, encoding: 'utf8', timeout: 30_000 });
  assert.notEqual(run.status, 0);
  assert.equal(readFileSync(calls, 'utf8').split('\n')[0].split(' ')[0], 'init', 'the guard let a scratch home through to the first CLI call');
});
