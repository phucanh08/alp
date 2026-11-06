// t-5294.6: the teardown shape every test in this repository uses, and the lint that keeps it.
//
// node:test runs a test's `t.after` hooks in registration order and stops at the first that throws.
// Three CI runs on 2026-11-06 hung to the 300 s per-file watchdog because one `rm(directory)` hook,
// registered before the hook closing the server inside it, threw ENOTEMPTY and took the close with
// it. The first test here is that failure and its fix, side by side, through the real runner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { teardown } from '../support/teardown.js';
import { ALLOWED, teardownProblems } from '../../scripts/check-teardown-order.mjs';

const HELPER = new URL('../support/teardown.js', import.meta.url).href;
const RUNNER = new URL('../../scripts/test-lib.mjs', import.meta.url).href;

/** Runs one throwaway test file through the real runner with a short deadline; returns its output. */
async function runFile(source, { timeoutMs = 2500 } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-teardown-shape-'));
  const file = path.join(directory, 'shape.test.mjs');
  await writeFile(file, source);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
    `import {runNodeTests} from ${JSON.stringify(RUNNER)};process.exitCode=runNodeTests([${JSON.stringify(file)}],{privateHome:true,fileTimeoutMs:${timeoutMs}});`],
    { env, timeout: 30_000 }).catch(error => error);
  const stderr = result.stderr ?? '';
  const retained = stderr.match(/warning: cleanup unconfirmed; retained (.+)/)?.[1].split(', ') ?? [];
  // The runner puts its own [test-file] lines on stderr and the reporter's run, failures included,
  // on stdout: an assertion about a hook's error has to read stdout.
  return { stderr, stdout: result.stdout ?? '', code: result.code ?? 0, file, directory, retained };
}

/**
 * A test that opens a listening socket, then tears down in `steps` — written as the file under test
 * would write them. `shape: 'bare'` registers each step as its own `t.after` (the old shape, FIFO);
 * `shape: 'defer'` registers them through test/support/teardown.js (reverse order, every step runs).
 */
const fixture = (shape, steps) => `import test from 'node:test';
import net from 'node:net';
${shape === 'defer' ? `import { teardown } from ${JSON.stringify(HELPER)};` : ''}
test('holds a socket while it tears down', async t => {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const register = ${shape === 'defer' ? 'teardown(t)' : 'step => t.after(step)'};
  // In SETUP order: the directory was made first, so it is removed last; the server opened after it,
  // so it closes first. The old shape runs them in exactly the wrong order.
  ${steps.map(step => `register(${step});`).join('\n  ')}
});
test('a later test still passes', () => {});`;

const CLOSE = 'async () => { await new Promise(resolve => server.close(resolve)); console.log("CLOSED"); }';
const THROWING_RM = '() => { throw Object.assign(new Error("simulated ENOTEMPTY rmdir home"), { code: "ENOTEMPTY" }); }';

test('the old shape hangs to the watchdog on a failed rm; the shared teardown closes everything and fails in time', { timeout: 90_000 }, async t => {
  const defer = teardown(t);

  // RED: the shape of the three hung files. The rm hook was registered first, so node:test runs it
  // first, it throws, and the close after it never runs: the socket keeps the process alive.
  const old = await runFile(fixture('bare', [THROWING_RM, CLOSE]));
  defer(() => rm(old.directory, { recursive: true, force: true }));
  for (const directory of old.retained) defer(() => rm(directory, { recursive: true, force: true }));
  assert.equal(old.code, 1, old.stderr);
  assert.match(old.stderr, new RegExp(`\\[test-file\\] TIMEOUT ${old.file.replaceAll('\\', '\\\\')} after 2500 ms`), old.stderr);
  assert.ok(old.stderr.includes('HANG DUMP'), 'the old shape reaches the watchdog');
  assert.ok(!old.stdout.includes('CLOSED'), 'the close hook never ran: node:test stopped at the throwing rm');

  // GREEN: the same two steps, registered in the same setup order through the shared helper. It runs
  // them in reverse, so the close happens first, and the failed rm still fails the test.
  const fixed = await runFile(fixture('defer', [THROWING_RM, CLOSE]));
  defer(() => rm(fixed.directory, { recursive: true, force: true }));
  for (const directory of fixed.retained) defer(() => rm(directory, { recursive: true, force: true }));
  assert.equal(fixed.code, 1, fixed.stderr);
  assert.ok(fixed.stdout.includes('CLOSED'), `the server was closed before the rm threw:\n${fixed.stderr}`);
  assert.ok(!fixed.stderr.includes('TIMEOUT'), `the file ended on its own, well inside the deadline:\n${fixed.stderr}`);
  assert.ok(!fixed.stderr.includes('HANG DUMP'), 'nothing kept the process alive');
  assert.match(fixed.stdout, /simulated ENOTEMPTY rmdir home/, 'and the rm failure is still reported');
  assert.match(fixed.stdout, /a later test still passes/, 'the rest of the file still ran');
  assert.equal(fixed.retained.length, 0, 'a file that ends in time leaves no retained scratch');
});

test('every step runs even when an earlier one throws, and the test fails with all of the errors', { timeout: 60_000 }, async t => {
  const defer = teardown(t);
  // The throwing step is registered LAST, so it runs FIRST: the close after it must still happen.
  const run = await runFile(fixture('defer', [THROWING_RM, CLOSE, '() => { throw new Error("kill failed"); }']));
  defer(() => rm(run.directory, { recursive: true, force: true }));
  for (const directory of run.retained) defer(() => rm(directory, { recursive: true, force: true }));
  assert.equal(run.code, 1, run.stderr);
  assert.ok(run.stdout.includes('CLOSED'), `a step that threw first did not skip the close:\n${run.stderr}`);
  assert.ok(!run.stderr.includes('TIMEOUT'), run.stderr);
  // Both failures are reported, not just the one that happened to run first.
  assert.match(run.stdout, /teardown failed/, run.stdout);
  assert.match(run.stdout, /kill failed/, run.stdout);
  assert.match(run.stdout, /simulated ENOTEMPTY/, run.stdout);
});

test('teardown(t) is one hook per context: a fixture helper and the test body share one ordered list', () => {
  const order = [];
  const hooks = [];
  const t = { after: hook => hooks.push(hook) };
  const fromFixture = teardown(t);
  const fromBody = teardown(t);
  assert.equal(fromBody, fromFixture, 'the same defer, so the orders cannot interleave wrongly');
  assert.equal(hooks.length, 1, 'and one after hook, whatever node:test does with several');
  fromFixture(() => order.push('rm directory'));
  fromFixture(() => order.push('shutdown runtime'));
  fromBody(() => order.push('close client'));
  return hooks[0]().then(
    () => assert.deepEqual(order, ['close client', 'shutdown runtime', 'rm directory']),
  );
});

test('a step deferred by another step still runs, and no step runs twice', async () => {
  const order = [];
  const hooks = [];
  const t = { after: hook => hooks.push(hook) };
  const defer = teardown(t);
  defer(() => order.push('outer'));
  defer(() => { order.push('middle'); defer(() => order.push('deferred by middle')); });
  await hooks[0]();
  assert.deepEqual(order, ['middle', 'deferred by middle', 'outer']);
  await hooks[0]();
  assert.deepEqual(order, ['middle', 'deferred by middle', 'outer'], 'the hook running again repeats nothing');
});

test('the lint reads registration order, not file order: it expands a fixture helper at its call site', () => {
  // The exact shape of packages/runtime/tests/runtime.test.js:223 before this task.
  const viaHelper = `import test from 'node:test';
async function setup(t) {
  const root = await mkdtemp('x');
  const runtime = create();
  t.after(() => runtime.shutdown());
  return { root, runtime };
}
test('one', async t => {
  const directory = await mkdtemp('y');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { runtime } = await setup(t);
  await runtime.open();
});`;
  const problems = teardownProblems('f.test.js', viaHelper);
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.equal(problems[0].site, 'f.test.js:10', 'the rm in the test body');
  assert.equal(problems[0].skips, 'f.test.js:5', 'the shutdown the helper registers after it');

  // The same two hooks the right way round report nothing.
  assert.deepEqual(teardownProblems('f.test.js', viaHelper.replace(
    "  t.after(() => rm(directory, { recursive: true, force: true }));\n  const { runtime } = await setup(t);",
    "  const { runtime } = await setup(t);\n  t.after(() => rm(directory, { recursive: true, force: true }));")), []);
});

test('the lint does not flag hooks that cannot skip each other', () => {
  // Two different tests: one test's failing hook cannot skip another test's.
  assert.deepEqual(teardownProblems('f.test.js', `import test from 'node:test';
test('one', async t => { t.after(() => rm(a)); });
test('two', async t => { t.after(() => server.close()); });`), []);

  // A file-level test.after always runs after every per-test hook (packages/runtime/tests/claude-fork.test.js:18).
  assert.deepEqual(teardownProblems('f.test.js', `import test from 'node:test';
test.after(() => rm(directory, { recursive: true, force: true }));
test('one', async t => { t.after(() => transport.close()); });`), []);

  // One hook that releases and then removes, in that order, is already correct.
  assert.deepEqual(teardownProblems('f.test.js', `import test from 'node:test';
test('one', async t => {
  t.after(async () => { await server.close(); await rm(directory, { recursive: true, force: true }); });
  t.after(() => client.close());
});`), []);

  // The shared helper's defer is not an after call, so a converted file is clean by construction.
  assert.deepEqual(teardownProblems('f.test.js', `import test from 'node:test';
test('one', async t => {
  const defer = teardown(t);
  defer(() => rm(directory, { recursive: true, force: true }));
  defer(() => server.close());
});`), []);
});

test('the lint catches the plain shape, and an allowlist entry must name the site it excuses', () => {
  const bad = `import test from 'node:test';
test('one', async t => {
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.after(async () => { await server.close(); await runtime.shutdown(); });
});`;
  const problems = teardownProblems('f.test.js', bad);
  assert.equal(problems.length, 1, JSON.stringify(problems));
  assert.equal(problems[0].site, 'f.test.js:3');
  assert.match(problems[0].detail, /hangs to the watchdog/);
  // Every allowlisted site carries a reason, so the list cannot quietly grow into a baseline.
  for (const [site, reason] of Object.entries(ALLOWED)) {
    assert.match(site, /^[\w./-]+\.test\.js:\d+$/, site);
    assert.ok(typeof reason === 'string' && reason.length > 20, `${site} needs a reason, got ${JSON.stringify(reason)}`);
  }
});
