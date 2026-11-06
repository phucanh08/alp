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
// Exit 0 when clean, 1 with a report when not. Run by scripts/validate.mjs (scope all|core, so the
// CI lanes `core` and `core-paseo-macos`), as `npm run check:teardown-order`, and by
// test/integration/teardown-order.test.js, which also fails on a STALE entry in ALLOWED below.
import { readFileSync } from 'node:fs';
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
 * Sites to leave alone, each with the reason. A file-level `test.after` already runs after every
 * per-test hook, so it never needs an entry. Key: `<repo-relative path>:<line>`.
 *
 * This list is NOT a baseline: test/integration/teardown-order.test.js fails when an entry here is
 * no longer reported by a scan that ignores the list, so a site that has been fixed (or a line that
 * has moved) must be deleted from it rather than left to rot. Every entry below is a real defect
 * owned by another agent's branch in the same wave of work; each one goes when that branch lands.
 */
export const ALLOWED = {
  // Group D (board p-bfea7464 / p-c479d708, tasks t-5294.7 + t-9043): these four files are edited by
  // that branch in the same wave, so converting them here would only make a conflict. Real defects.
  'test/integration/binary-install-ps1.test.js:23': 'group D (t-5294.7, claim p-c479d708) converts this with the rest of its binary-install work; delete this entry when that branch lands',
  'test/integration/library-tools.test.js:20': 'group D via t-9043 (claim p-c479d708, decision p-a5af690e edits this same file); delete this entry when that branch lands',
  'test/integration/packs.test.js:17': 'group D via t-9043 (claim p-c479d708, decision p-a5af690e edits this same file); delete this entry when that branch lands',
  'test/integration/teams.test.js:68': 'group D via t-9043 (claim p-c479d708, decision p-a5af690e edits this same file); delete this entry when that branch lands',
  'test/integration/teams.test.js:110': 'group D via t-9043 (claim p-c479d708); this is the one site of lead\'s original 29 that group C does not own; delete this entry when that branch lands',
};

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
      // `teardown(t)` registers ONE hook, here. Everything the test registers with a bare `t.after`
      // after this point therefore runs after the whole defer list (t-5294.6, review finding M).
      events.push({ kind: 'teardown', context: node.initializer.arguments[0].text, position: node.getStart(),
        file: parsed.fileName, line: parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.name.text === 'after' && ts.isIdentifier(node.expression.expression)) {
      events.push({ kind: 'hook', context: node.expression.expression.text, position: node.getStart(),
        file: parsed.fileName, line: parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        ...classify(node.arguments.map(a => a.getText()).join('\n')) });
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && deferNames.has(node.expression.text)) {
      events.push({ kind: 'step', context: deferNames.get(node.expression.text), position: node.getStart(),
        file: parsed.fileName, line: parsed.getLineAndCharacterOfPosition(node.getStart()).line + 1,
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

/**
 * The RELATIVE named imports of a file: local name -> { specifier, imported }. A fixture helper
 * usually lives in a support module (`import { startGateway } from './support/harness.js'`), and the
 * hooks it registers land in the calling test's context exactly as a same-file helper's do. Reading
 * only the test file therefore misses them entirely, which is how apps/gateway/tests/support/
 * harness.js kept the hang shape through the whole of t-5294.6 (review finding M).
 */
function relativeImports(parsed) {
  const found = new Map();
  for (const statement of parsed.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('.')) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      found.set(element.name.text, { specifier, imported: (element.propertyName ?? element.name).text });
    }
  }
  return found;
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
function hooksOf(fn, context, unit, load, seen = new Set(), deferNames = new Map(), frame = 'test') {
  const hooks = [];
  for (const event of sequenceOf(fn, unit.parsed, deferNames)) {
    if (event.kind !== 'call') { if (event.context === context) hooks.push({ ...event, frame }); continue; }
    const index = event.arguments.indexOf(context);
    if (index < 0) continue;
    // The helper may be in this file, or imported from a support module beside it.
    let where = unit, helper = unit.helpers.get(event.name);
    if (!helper) {
      const imported = unit.imports.get(event.name);
      const other = imported && load(unit.relative, imported.specifier);
      helper = other?.helpers.get(imported.imported);
      if (helper) where = other;
    }
    const key = `${where.relative}#${event.name}`;
    if (!helper || seen.has(key)) continue;
    // The helper's own name for the context it was handed. `teardown(t)` inside it returns the very
    // same defer, so its steps belong to this list, spliced in where the helper is called.
    // Each invocation is its own frame: a test that calls the same fixture twice gets two sets of
    // steps, and the second fixture's removal must not be read as skipping the first's release.
    const inner = parameterNames(helper)[index];
    if (inner) hooks.push(...hooksOf(helper, inner, where, load, new Set([...seen, key]), new Map(deferNames), `${frame}>${event.name}@${event.position}`));
  }
  return hooks;
}

/** One parsed file: what hooksOf needs to read it and to follow a helper out of it. */
export function unitOf(relative, source) {
  const parsed = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  return { relative, parsed, helpers: namedFunctions(parsed), imports: relativeImports(parsed) };
}

/**
 * The order problems in one file's source. `allowed` defaults to ALLOWED; pass `{}` to see the
 * excused sites too, which is how the test checks that no entry has gone stale.
 */
export function teardownProblems(relative, source, allowed = ALLOWED, load = () => undefined) {
  const unit = unitOf(relative, source);
  const parsed = unit.parsed;
  /** One ordered hook list per test, plus one for the file-level `test.after` hooks. */
  const contexts = [];
  const fileLevel = [];
  const walk = node => {
    if (testCallName(node)) {
      const body = node.arguments.find(functionLike);
      const context = body && parameterNames(body)[0];
      if (body && context) contexts.push(hooksOf(body, context, unit, load));
    }
    // A file-level hook (`test.after`) runs after every per-test hook: its own order is all that matters.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'after'
        && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'test') {
      fileLevel.push(...sequenceOf(node, parsed).filter(event => event.kind === 'hook'));
    }
    ts.forEachChild(node, walk);
  };
  walk(parsed);
  /** `file:line`, naming the support module when the hook was registered there, not the test file. */
  const at = entry => `${entry.file ?? relative}:${entry.line}`;

  const problems = [];
  const add = problem => {
    if (Object.hasOwn(allowed, problem.site)) return;
    if (problems.some(seen => seen.site === problem.site && seen.skips === problem.skips)) return;
    problems.push(problem);
  };
  for (const registrations of [...contexts, fileLevel]) {
    const steps = registrations.filter(entry => entry.kind === 'step');
    const teardownAt = registrations.find(entry => entry.kind === 'teardown');
    /**
     * node:test runs the hooks of one test in registration order, and `teardown(t)` is ONE of them.
     * So the comparable unit is not a single `defer` step but the whole list, registered where
     * `teardown(t)` was called: it releases if any step releases, removes if any step removes, and
     * runs its releases before its removals because it runs in reverse (the `step` rule below is
     * what checks that the steps inside it are in the right order). Normalising it this way is what
     * lets the three shapes be one rule — two bare hooks, a bare removal before a defer list that
     * releases, and a bare release after a defer list that removes (review finding M: all three are
     * present in apps/gateway/tests).
     */
    const list = teardownAt && steps.length ? {
      kind: 'list', position: teardownAt.position, file: teardownAt.file, line: teardownAt.line,
      removes: steps.some(step => step.removes), releases: steps.some(step => step.releases),
    } : undefined;
    if (list) list.releasesFirst = list.removes && list.releases;
    // Registration order, which is `registrations` as hooksOf built it — NOT line order. A test that
    // calls the same fixture twice registers two sets of hooks from the same lines, and the first
    // set's removal really does come before the second set's release (test/integration/
    // teams.test.js:68 is that shape). Sorting by position would merge the two frames and lose it.
    // Only the FIRST teardown(t) becomes a list: calling it again returns the same defer, so it
    // registers no second hook, however many fixtures in the chain ask for one.
    let listPlaced = false;
    const order = registrations.flatMap(entry => {
      if (entry.kind === 'hook') return [entry];
      if (entry.kind === 'teardown' && list && !listPlaced) { listPlaced = true; return [list]; }
      return [];
    });
    const describe = entry => (entry.kind === 'list' ? `the teardown(t) list started at ${at(entry)}` : `the after hook at ${at(entry)}`);

    for (const [index, entry] of order.entries()) {
      // A removal that cannot be reached past: every hook after it is skipped when it throws.
      //
      // KNOWN LIMITATION, measured and deliberate (t-5294.8). `releasesFirst` — one bare hook that
      // does `await close(); await rm(dir)` — is skipped here, and that is NOT the same as safe: if
      // its rm throws, every LATER hook is still stranded. Lifting the exemption reports 97 pairs
      // over 36 sites in 31 files on this tree, a family far outside one assignment, so it is
      // tracked as its own task instead: a lint that fails the build on 31 files nobody is
      // converting gets switched off, and then it protects nothing.
      //
      // The live one worth knowing: packages/daemon/tests/model-catalog.test.js:155 kills a real
      // alpd child and THEN removes its directory, registered before the `client.close()` at :161 —
      // in the same file that hung core-paseo-macos twice on 2026-11-06, in the `core` lane that
      // runs today. If that rm throws, the IPC socket stays open and the file sits to the watchdog.
      if (entry.removes && !entry.releasesFirst) {
        const later = order.slice(index + 1).find(other => other.releases);
        if (later) add({ site: at(entry), skips: at(later),
          detail: `${describe(entry)} removes a path and is registered before ${describe(later)}, which releases a resource: node:test stops at the first after hook that throws, so the release never runs and the file hangs to the watchdog. Register both through test/support/teardown.js (defer), each step right after the setup it undoes` });
      }
    }

    // A `defer` step runs in REVERSE registration order, so the rule inverts: register each step
    // right after the setup it undoes, which puts the removal FIRST and the release after it.
    // Only within one frame: across two invocations of the same fixture, the second's removal
    // legitimately follows the first's release, and each pair is undone correctly on its own.
    for (const [index, entry] of steps.entries()) {
      if (!entry.releases || entry.removes || entry.releasesFirst) continue;
      const later = steps.slice(index + 1).find(other => other.removes && !other.releases && other.frame === entry.frame);
      if (later) add({ site: at(entry), skips: at(later),
        detail: `${at(entry)} releases a resource in a defer step registered before the removal at ${at(later)}; defer runs in reverse, so the path would be removed FIRST. Register each step right after the setup it undoes` });
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

/**
 * Loads a relative import as a unit, so a fixture helper in a support module is expanded at its call
 * site like a local one. Cached: one support module serves a dozen test files.
 */
function moduleLoader() {
  const cache = new Map();
  return (from, specifier) => {
    const relative = path.join(path.dirname(from), specifier).split(path.sep).join('/');
    if (!cache.has(relative)) {
      let source;
      try { source = readFileSync(path.join(root, relative), 'utf8'); } catch { source = undefined; }
      cache.set(relative, source === undefined ? undefined : unitOf(relative, source));
    }
    return cache.get(relative);
  };
}

/** Every problem in the tree at `root`. Pass `{ allowed: {} }` to include the excused sites. */
export async function scan({ allowed = ALLOWED } = {}) {
  const problems = [];
  const load = moduleLoader();
  for (const directory of TEST_DIRECTORIES) {
    for (const relative of await testFiles(directory)) {
      problems.push(...teardownProblems(relative, await readFile(path.join(root, relative), 'utf8'), allowed, load));
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
  } else {
    const excused = Object.keys(ALLOWED).length;
    console.log(`teardown order: no problems in ${TEST_DIRECTORIES.length} test directories`
      + (excused ? `, ${excused} site${excused === 1 ? '' : 's'} allowlisted (open on another branch; see ALLOWED)` : ''));
  }
  process.exitCode = problems.length ? 1 : 0;
}
