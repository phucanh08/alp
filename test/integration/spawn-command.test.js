// t-ffe4.5: one place knows how to start tar and how to describe a failed spawnSync. The Windows
// tar workaround (the system's bsdtar, never Git Bash's GNU tar that comes first on PATH under
// `shell: bash`) used to be hand-written per script; a third script missed it and turned the Windows
// release-acceptance row red, and check-paseo-compat.mjs still ran bare `tar`.
// t-ffe4.6: the scan below used to read only scripts/*.mjs and only for `spawn('tar'` written out in
// full, so four copies of the same knowledge outside scripts/ were invisible to it, as was any
// `execFileSync('tar')` or command held in a variable. It now parses every source file in the repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { systemTar } from '../../packages/cli/src/self-update.js';
import { exitDescription, spawnCommand, windowsTar } from '../../scripts/spawn-command.mjs';

const root = path.resolve(import.meta.dirname, '../..');

function onPlatform(t, platform) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
}

test('tar is the system bsdtar on Windows, from SystemRoot, whatever PATH says', t => {
  onPlatform(t, 'win32');
  const saved = process.env.SystemRoot;
  process.env.SystemRoot = 'E:\\Win';
  t.after(() => { if (saved === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = saved; });
  assert.deepEqual(spawnCommand('tar', ['-xzf', 'D:\\a\\x.tgz']), ['E:\\Win\\System32\\tar.exe', ['-xzf', 'D:\\a\\x.tgz']]);
  assert.equal(windowsTar({}), 'C:\\Windows\\System32\\tar.exe');
});

test('tar and other commands are unchanged on macOS and Linux', t => {
  for (const platform of ['darwin', 'linux']) {
    onPlatform(t, platform);
    assert.deepEqual(spawnCommand('tar', ['-xzf', '/tmp/x.tgz']), ['tar', ['-xzf', '/tmp/x.tgz']]);
    assert.deepEqual(spawnCommand('npm', ['ci']), ['npm', ['ci']]);
    assert.deepEqual(spawnCommand('git', ['status']), ['git', ['status']]);
  }
});

test('exitDescription names the start error, then the signal, then the exit status', () => {
  assert.equal(exitDescription({ error: new Error('spawn tar ENOENT'), status: null }), 'could not run to completion: spawn tar ENOENT');
  assert.equal(exitDescription({ status: null, signal: 'SIGKILL' }), 'was killed by SIGKILL');
  assert.equal(exitDescription({ status: 2, signal: null }), 'exited 2');
});


// How tar may be started. `spawnCommand` is the helper; `windowsTar` and the shipped `systemTar` are
// the two places allowed to name the System32 path. A local function that forwards its own command
// to spawnCommand (check-paseo-compat.mjs's `run`, for one) counts as the helper too.
const HELPERS = new Set(['spawnCommand', 'windowsTar', 'systemTar']);
// Everything that starts a process in this repository. The old scan knew only the first two, so
// `execFileSync('tar', …)` passed it (t-ffe4.6).
const STARTERS = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']);
const namesTar = text => /(^|[\\/\s'"])tar(\.exe)?$/.test(text.trim());
// Declared, with the reason. Only files that may legitimately hold the knowledge are here, and each
// is held to the others by a test: 'every place that names the Windows tar path agrees' below.
const ALLOWED = new Map([
  ['scripts/spawn-command.mjs', 'defines spawnCommand and windowsTar'],
  ['packages/cli/src/self-update.js', 'defines systemTar: shipped code cannot import scripts/, so this copy is deliberate and pinned equal to windowsTar by a test'],
  ['test/integration/spawn-command.test.js', 'this file: it asserts on the literals'],
]);

/** Every source file of this repository, repo-relative, without build output or dependencies. */
function sourceFiles() {
  const out = [];
  for (const directory of ['scripts', 'test', 'packages', 'apps', 'integrations']) {
    for (const name of readdirSync(path.join(root, directory), { recursive: true })) {
      const relative = path.join(directory, String(name)).split(path.sep).join('/');
      if (!/\.(?:js|mjs|cjs|ts|mts)$/.test(relative) || /\.d\.ts$/.test(relative)) continue;
      if (/(?:^|\/)(?:node_modules|dist|build|fixtures|coverage|\.git)\//.test(relative)) continue;
      out.push(relative);
    }
  }
  return out;
}

/** The names of functions in this file that hand their own command to spawnCommand. */
function forwarders(source) {
  const names = new Set();
  const visit = node => {
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name && node.body && node.body.getText().includes('spawnCommand(')) names.add(node.name.getText());
    if (ts.isVariableDeclaration(node) && node.name && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) && node.initializer.getText().includes('spawnCommand(')) names.add(node.name.getText());
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/** Whether `node` is a call of one of the helpers, possibly spread into the starter's arguments. */
function fromHelper(node) {
  const call = ts.isSpreadElement(node) ? node.expression : node;
  if (!ts.isCallExpression(call)) return false;
  const name = ts.isPropertyAccessExpression(call.expression) ? call.expression.name.getText() : call.expression.getText();
  return HELPERS.has(name);
}

/** What `identifier` was initialized to in this file, if it is declared here. */
function initializerOf(source, identifier) {
  let found;
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.initializer && node.name.getText() === identifier) found ??= node.initializer;
    // `const [tar, args] = spawnCommand('tar', …)`: the binding pattern names it.
    if (ts.isVariableDeclaration(node) && node.initializer && !ts.isIdentifier(node.name) && node.name.getText().includes(identifier)) found ??= node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Every place in `relative` that starts tar, or names its Windows path, without the helper. */
function tarProblems(relative, text) {
  const problems = [];
  const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
  const line = node => source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  // A hand-copied System32 tar path, in any of the three ways it has been written here.
  for (const match of text.matchAll(/System32['"]?\s*[,+]\s*['"]\/?tar\.exe|System32[\\/]{1,2}tar\.exe/g)) {
    problems.push(`${relative}:${text.slice(0, match.index).split('\n').length}: its own copy of the Windows tar path`);
  }
  const forwards = forwarders(source);
  const visit = node => {
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.getText() : node.expression.getText();
      const first = node.arguments[0];
      if (STARTERS.has(callee) && first) {
        if (!fromHelper(first)) {
          if (ts.isStringLiteralLike(first) && namesTar(first.text)) problems.push(`${relative}:${line(node)}: ${callee} starts tar without spawnCommand`);
          else if (ts.isIdentifier(first)) {
            const initializer = initializerOf(source, first.getText());
            const resolved = initializer && fromHelper(initializer);
            if (!resolved && (/tar/i.test(first.getText()) || (initializer && ts.isStringLiteralLike(initializer) && namesTar(initializer.text)))) {
              problems.push(`${relative}:${line(node)}: ${callee} starts tar through the variable ${first.getText()}, not spawnCommand`);
            }
          } else if (!ts.isIdentifier(first) && /\btar\b/.test(first.getText()) && !fromHelper(first)) {
            problems.push(`${relative}:${line(node)}: ${callee} starts tar without spawnCommand (${first.getText().slice(0, 60)})`);
          }
        }
      } else if (!HELPERS.has(callee) && !forwards.has(callee)) {
        // Handing the command name to anything else: a wrapper that is not the helper.
        for (const argument of node.arguments) if (ts.isStringLiteralLike(argument) && argument.text.trim() === 'tar') problems.push(`${relative}:${line(node)}: passes 'tar' to ${callee}, which does not go through spawnCommand`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return problems;
}

// t-ffe4.6: the four copies the old scan could not see were packages/cli/src/self-update.js (its own
// systemTar), packages/cli/tests/self-update.test.js (bare spawnSync('tar') that GNU tar cannot
// serve, since it writes a zip), test/integration/binary-install-ps1.test.js (its own System32 path)
// and test/integration/binary-release.test.js (bare execFileSync('tar')).
test('nothing in the repository starts tar or names its Windows path except through the helpers (t-ffe4.6)', () => {
  const problems = [];
  const unused = new Set(ALLOWED.keys());
  for (const relative of sourceFiles()) {
    const found = tarProblems(relative, readFileSync(path.join(root, relative), 'utf8'));
    if (!found.length) continue;
    if (ALLOWED.has(relative)) { unused.delete(relative); continue; }
    problems.push(...found);
  }
  assert.deepEqual(problems, []);
  // An allowlist entry that no longer matches anything is a stale permission: delete it.
  assert.deepEqual([...unused], [], 'these files no longer need to be allowed');
});

test('the scan sees tar started in every shape, and the helper in every shape (t-ffe4.6)', () => {
  // Shapes that must be reported. The old scan caught only the first.
  for (const [source, expected] of [
    [`spawnSync('tar', ['-czf', a]);`, /spawnSync starts tar without spawnCommand/],
    [`execFileSync('tar', ['-tzf', a]);`, /execFileSync starts tar without spawnCommand/],
    [`execFile('tar', ['-tzf', a], cb);`, /execFile starts tar without spawnCommand/],
    [`execSync('tar -tzf ' + a);`, /execSync starts tar without spawnCommand/],
    [`spawn("tar", args);`, /spawn starts tar without spawnCommand/],
    [`const cmd = 'tar'; spawnSync(cmd, args);`, /through the variable cmd/],
    [`const tarPath = whatever(); spawnSync(tarPath, args);`, /through the variable tarPath/],
    [`run('tar', ['-xzf', a]);`, /passes 'tar' to run, which does not go through spawnCommand/],
    [`const t = path.join(env.SystemRoot, 'System32', 'tar.exe');`, /its own copy of the Windows tar path/],
    [`const t = 'C:\\\\Windows\\\\System32\\\\tar.exe';`, /its own copy of the Windows tar path/],
  ]) {
    const found = tarProblems('probe.mjs', source);
    assert.equal(found.length, 1, `${source} -> ${JSON.stringify(found)}`);
    assert.match(found[0], expected, source);
  }
  // Shapes that are the helper, and must not be reported.
  for (const source of [
    `spawnSync(...spawnCommand('tar', args), options);`,
    `const [tar, args] = spawnCommand('tar', list); spawnSync(tar, args);`,
    `execFileSync(windowsTar(), ['-xf', zip]);`,
    `spawnSync(systemTar(), ['-xzf', archive]);`,
    `function run(c, a) { return spawnSync(...spawnCommand(c, a)); } run('tar', ['-xzf', f]);`,
    `const run = (c, a) => spawnSync(...spawnCommand(c, a)); run('tar', ['-xzf', f]);`,
    `spawnSync('git', ['status']);`,
    `execFileSync('powershell.exe', ['-Command', script]);`,
    `spawnSync(process.execPath, ['--test', file]);`,
  ]) assert.deepEqual(tarProblems('probe.mjs', source), [], source);
});

// The shipped duplicate: packages/cli is a published package and cannot import scripts/, so
// self-update.js keeps its own systemTar. Nothing stops the two from drifting except this.
test('every place that names the Windows tar path agrees (t-ffe4.6)', () => {
  for (const env of [{ SystemRoot: 'E:\\Win' }, { SystemRoot: 'C:\\WINDOWS' }, {}]) {
    assert.equal(systemTar('win32', env), windowsTar(env), JSON.stringify(env));
  }
  assert.equal(systemTar('darwin', {}), 'tar');
  assert.equal(systemTar('linux', { SystemRoot: 'E:\\Win' }), 'tar', 'SystemRoot does not reach a POSIX host');
});
