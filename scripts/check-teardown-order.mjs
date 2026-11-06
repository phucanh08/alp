#!/usr/bin/env node
// The teardown-order lint (t-5294.6). node:test runs a test's `t.after` hooks in registration order
// and STOPS at the first one that throws, so a hook that removes a directory, registered BEFORE the
// hook that closes the server or kills the child living in it, turns one routine ENOTEMPTY into a
// file that keeps its sockets open until the 300 s per-file watchdog stops it. The test shows ✖, the
// tests after it still pass, and nothing says why the file never exited. That hung CI three times on
// 2026-11-06 (core-paseo-macos 127622779702/127628147149, windows-daemon 22/24).
//
// This is the scan that found the original 29 sites, kept in the repository so the next one is caught
// at review instead of at 3 a.m. For each test it builds the hooks' registration order — expanding a
// fixture helper (`await setup(t)`) at the point it is called, which is where its hooks land — and
// reports a hook that removes a path when a LATER hook of the SAME test releases a resource
// (close/shutdown/stop/kill/...).
//
// The fix is never to reorder the two hooks by hand; the next person adds a third in the wrong place.
// Use test/support/teardown.js, registering each step right after the setup it undoes:
//
//     const defer = teardown(t);
//     defer(() => rm(directory, ...));   // registered first, so undone LAST
//     defer(() => server.close());       // registered last, so undone FIRST
//
// `defer` is not a `.after` call, so a converted file reports nothing here by construction.
//
// Usage: node scripts/check-teardown-order.mjs [--root <dir>] [--json]
// Exit 0 when clean, 1 with a report when not. Run by test/integration/teardown-order.test.js.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const argument = name => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const root = path.resolve(argument('--root') ?? path.join(import.meta.dirname, '..'));

/** Where this repository keeps `*.test.js`: every workspace's tests, plus the cross-package suites. */
const TEST_DIRECTORIES = ['test/integration', 'apps/web/tests', 'apps/gateway/tests', 'apps/tui/tests',
  ...['protocol', 'core', 'runtime', 'client', 'daemon', 'cli', 'gateway'].map(name => `packages/${name}/tests`),
  'integrations/paseo/tests'];

/** A hook body that deletes something: the step that must run LAST. */
const REMOVES = /\b(?:rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync)\s*\(/;
/**
 * A hook body that releases a resource which can hold that directory open, or whose omission leaks a
 * process: the step that must run FIRST. `.flush(` counts because a store still writing is exactly
 * what makes the removal throw, and restoring a saved global (`process.env.X = saved`) counts because
 * a skipped restore silently changes every later test in the file.
 */
const RELEASES = /\.(?:close|closeAllConnections|shutdown|stop|kill|destroy|disconnect|terminate|flush)\s*\(/;

/**
 * Sites to leave alone, each with the reason it is safe. A file-level `test.after` already runs after
 * every per-test hook, so it never needs an entry. Key: `<repo-relative path>:<line>`.
 */
export const ALLOWED = {};

const functionLike = node => ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node);
const parameterNames = node => node.parameters.map(p => (ts.isIdentifier(p.name) ? p.name.text : undefined));
/** `test`, `it`, `test.only`, `t.test`, ... : a call whose last argument is the body of one test. */
const testCallName = node => {
  if (!ts.isCallExpression(node)) return undefined;
  const callee = node.expression;
  const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : undefined;
  return name === 'test' || name === 'it' ? name : undefined;
};

/** What a hook or step body does, from its source text. */
function classify(body) {
  return {
    removes: REMOVES.test(body), releases: RELEASES.test(body),
    // One step that releases and then removes, in that order, is already correct on its own.
    releasesFirst: RELEASES.test(body) && REMOVES.test(body) && body.search(RELEASES) < body.search(REMOVES),
  };
}

/**
 * The teardown registrations and helper calls inside `fn`, in textual order (which is the order they
 * run in), skipping anything inside a nested test body — that is a context of its own.
 *
 * Two kinds of registration are tracked, because they have OPPOSITE correct orders:
 *   `hook`, a bare `t.after(...)`, which node:test runs in registration order, and
 *   `step`, a `defer(...)` from test/support/teardown.js, which runs in REVERSE registration order.
 * `deferNames` maps a name bound to `teardown(X)` onto the context X it tears down.
 */
function sequenceOf(fn, parsed, deferNames = new Map()) {
  const events = [];
  const walk = node => {
    if (node !== fn && functionLike(node) && node.parent && testCallName(node.parent)) return;
    // `const defer = teardown(t)`: remember which context this name registers steps for.
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
        && ts.isCallExpression(node.initializer) && ts.isIdentifier(node.initializer.expression)
        && node.initializer.expression.text === 'teardown' && ts.isIdentifier(node.initializer.arguments[0])) {
      deferNames.set(node.name.text, node.initializer.arguments[0].text);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'after' && ts.isIdentifier(node.expression.expression)) {
      events.push({ kind: 'hook', context: node.expression.expression.text, position: node.getStart(),
        line: parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        ...classify(node.arguments.map(a => a.getText()).join('\n')) });
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && deferNames.has(node.expression.text)) {
      events.push({ kind: 'step', context: deferNames.get(node.expression.text), position: node.getStart(),
        line: parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        ...classify(node.arguments.map(a => a.getText()).join('\n')) });
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      events.push({ kind: 'call', name: node.expression.text, position: node.getStart(),
        arguments: node.arguments.map(a => (ts.isIdentifier(a) ? a.text : undefined)) });
    }
    ts.forEachChild(node, walk);
  };
  walk(fn);
  return events.sort((a, b) => a.position - b.position);
}

/** Every module-level named function (declaration or `const name = ... =>`), by name. */
function namedFunctions(parsed) {
  const found = new Map();
  const walk = node => {
    if (ts.isFunctionDeclaration(node) && node.name) found.set(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && functionLike(node.initializer)) {
      found.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, walk);
  };
  walk(parsed);
  return found;
}

/**
 * The hooks one test registers on its own context, in order: its body's own `t.after` calls with the
 * hooks of every fixture helper it passes `t` to spliced in where the call happens.
 */
function hooksOf(fn, context, parsed, helpers, seen = new Set(), deferNames = new Map(), frame = 'test') {
  const hooks = [];
  for (const event of sequenceOf(fn, parsed, deferNames)) {
    if (event.kind !== 'call') { if (event.context === context) hooks.push({ ...event, frame }); continue; }
    const helper = helpers.get(event.name);
    const index = event.arguments.indexOf(context);
    if (!helper || index < 0 || seen.has(event.name)) continue;
    // The helper's own name for the context it was handed. `teardown(t)` inside it returns the very
    // same defer, so its steps belong to this list, spliced in where the helper is called.
    // Each invocation is its own frame: a test that calls the same fixture twice gets two sets of
    // steps, and the second fixture's removal must not be read as skipping the first's release.
    const inner = parameterNames(helper)[index];
    if (inner) hooks.push(...hooksOf(helper, inner, parsed, helpers, new Set([...seen, event.name]), new Map(deferNames), `${frame}>${event.name}@${event.position}`));
  }
  return hooks;
}

/** The order problems in one file's source. */
export function teardownProblems(relative, source) {
  const parsed = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const helpers = namedFunctions(parsed);
  /** One ordered hook list per test, plus one for the file-level `test.after` hooks. */
  const contexts = [];
  const fileLevel = [];
  const walk = node => {
    if (testCallName(node)) {
      const body = node.arguments.find(functionLike);
      const context = body && parameterNames(body)[0];
      if (body && context) contexts.push(hooksOf(body, context, parsed, helpers));
    }
    // A file-level hook (`test.after`) runs after every per-test hook: its own order is all that matters.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'after'
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'test') {
      fileLevel.push(...sequenceOf(node, parsed).filter(event => event.kind === 'hook'));
    }
    ts.forEachChild(node, walk);
  };
  walk(parsed);

  const problems = [];
  const add = problem => {
    if (Object.hasOwn(ALLOWED, problem.site)) return;
    if (problems.some(seen => seen.site === problem.site && seen.skips === problem.skips)) return;
    problems.push(problem);
  };
  for (const registrations of [...contexts, fileLevel]) {
    for (const [index, entry] of registrations.entries()) {
      if (entry.releasesFirst) continue;
      // A bare `t.after` runs in registration order: a removal must come after every release.
      if (entry.kind === 'hook' && entry.removes) {
        const later = registrations.slice(index + 1).find(other => other.kind === 'hook' && other.releases);
        if (later) add({ site: `${relative}:${entry.line}`, skips: `${relative}:${later.line}`,
          detail: `${relative}:${entry.line} removes a path in an after hook registered before ${relative}:${later.line}, which releases a resource: if the removal throws, node:test never runs the release and the file hangs to the watchdog` });
      }
      // A `defer` step runs in REVERSE registration order, so the rule inverts: register each step
      // right after the setup it undoes, which puts the removal FIRST and the release after it.
      // Only within one frame: across two invocations of the same fixture, the second's removal
      // legitimately follows the first's release, and each pair is undone correctly on its own.
      if (entry.kind === 'step' && entry.releases && !entry.removes) {
        const later = registrations.slice(index + 1).find(other => other.kind === 'step' && other.removes && !other.releases && other.frame === entry.frame);
        if (later) add({ site: `${relative}:${entry.line}`, skips: `${relative}:${later.line}`,
          detail: `${relative}:${entry.line} releases a resource in a defer step registered before the removal at ${relative}:${later.line}; defer runs in reverse, so the path would be removed FIRST. Register each step right after the setup it undoes` });
      }
    }
  }
  return problems;
}

async function testFiles(directory) {
  try {
    return (await readdir(path.join(root, directory), { recursive: true }))
      .filter(file => file.endsWith('.test.js') || file.endsWith('.test.mjs'))
      .map(file => path.join(directory, file).split(path.sep).join('/')).sort();
  } catch { return []; }
}

/** Every problem in the tree at `root`. */
export async function scan() {
  const problems = [];
  for (const directory of TEST_DIRECTORIES) {
    for (const relative of await testFiles(directory)) {
      problems.push(...teardownProblems(relative, await readFile(path.join(root, relative), 'utf8')));
    }
  }
  return problems;
}

// Only when run as a command: test/integration/teardown-order.test.js imports teardownProblems and
// ALLOWED, and must not inherit this script's exit code.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = await scan();
  if (process.argv.includes('--json')) console.log(JSON.stringify(problems, null, 2));
  else if (problems.length) {
    console.error(`${problems.length} teardown-order problem${problems.length === 1 ? '' : 's'}: an after hook that removes a path is registered before one that releases a resource.`);
    console.error('node:test stops at the first after hook that throws, so the release never runs and the file hangs to the per-file watchdog.');
    console.error('Fix: register both through test/support/teardown.js (defer), each step right after the setup it undoes.\n');
    for (const problem of problems) console.error(`  ${problem.detail}`);
  } else console.log(`teardown order: no problems in ${TEST_DIRECTORIES.length} test directories`);
  process.exitCode = problems.length ? 1 : 0;
}
