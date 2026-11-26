// A test run never reaches the caller's AI providers (t-a87f). On a developer's machine agy, codex,
// claude and opencode are installed and logged in; scripts/test-lib.ts gives every run a private
// home, provider executables pinned to a missing path and a PATH without provider commands. Every
// "provider" here is a RECORDING FAKE in a scratch directory that only appends its own argv to a
// log: nothing real is started, and no path under the real home is used.
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { PINNED_PROVIDER_VARIABLES, PROVIDER_COMMANDS, providerFreePath } from '../../scripts/test-lib.ts';
import { teardown } from '../support/teardown.ts';

const posix = process.platform !== 'win32';

/** A scratch directory removed by the test's teardown. */
async function scratch(t: TestContext, prefix: string) {
  const defer = teardown(t);
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  defer(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** Recording fakes named after every provider in `bin`, each appending its own name and argv to `log`. */
async function recordingFakes(bin: string, log: string) {
  await mkdir(bin, { recursive: true });
  for (const name of PROVIDER_COMMANDS) {
    const file = path.join(bin, name);
    await writeFile(file, `#!/bin/sh\nprintf '%s %s\\n' '${name}' "$*" >> '${log}'\nexit 0\n`);
    await chmod(file, 0o755);
  }
}

test('providerFreePath keeps directories without providers and shadows the others without them', async t => {
  const root = await scratch(t, 'alp-provider-path-');
  const providers = path.join(root, 'providers');
  const plain = path.join(root, 'plain');
  await mkdir(plain);
  await writeFile(path.join(plain, 'codex-like-tool'), '');
  await recordingFakes(providers, path.join(root, 'never.log'));
  await writeFile(path.join(providers, 'Claude'), ''); // a case-insensitive file system resolves `claude` to it
  await writeFile(path.join(providers, 'git'), '');
  const shadowRoot = path.join(root, 'shadow');
  const result = providerFreePath([plain, providers, path.join(root, 'missing')].join(':'), shadowRoot, { platform: 'linux' }).split(':');
  assert.deepEqual(result, [plain, path.join(shadowRoot, '0')], 'a directory that cannot be listed is dropped');
  assert.deepEqual(await readdir(path.join(shadowRoot, '0')), ['git'], 'only the non-provider entry is linked');
});

test('providerFreePath drops a directory it cannot list instead of keeping it (fail closed)', { skip: !posix || process.getuid?.() === 0 ? 'needs POSIX permissions and a non-root user' : false }, async t => {
  const root = await scratch(t, 'alp-provider-path-locked-');
  const locked = path.join(root, 'locked');
  await recordingFakes(locked, path.join(root, 'never.log'));
  await chmod(locked, 0o111); // execute-only: a program in it can still be started by name, but it cannot be listed
  teardown(t)(() => chmod(locked, 0o755)); // runs before the scratch removal registered above
  const plain = path.join(root, 'plain');
  await mkdir(plain);
  const result = providerFreePath([locked, plain].join(':'), path.join(root, 'shadow'), { platform: 'linux' }).split(':');
  assert.deepEqual(result, [plain]);
});

test('providerFreePath on Windows drops providers with any executable extension, case-insensitively', async t => {
  const root = await scratch(t, 'alp-provider-path-win-');
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  for (const name of ['codex.cmd', 'CLAUDE.EXE', 'agy.exe', 'opencode.ps1', 'node.exe', 'codexx.exe', 'claude-helper.cmd']) await writeFile(path.join(bin, name), '');
  const [shadow] = providerFreePath(bin, path.join(root, 'shadow'), { platform: 'win32' }).split(';');
  if (!posix) assert.equal(shadow, path.join(root, 'shadow', '0'));
  const kept = (await readdir(shadow)).sort();
  // A file system that refuses symlinks leaves the entry out rather than reaching the original.
  for (const name of kept) assert.ok(['claude-helper.cmd', 'codexx.exe', 'node.exe'].includes(name), name);
  if (posix) assert.deepEqual(kept, ['claude-helper.cmd', 'codexx.exe', 'node.exe']);
});

test('a runNodeTests run with recording fakes first on PATH and as ALP_*_BIN reaches none of them', { skip: !posix && 'POSIX shell fakes', timeout: 60_000 }, async t => {
  const root = await scratch(t, 'alp-provider-run-');
  const log = path.join(root, 'calls.log');
  const fakes = path.join(root, 'fakes');
  await recordingFakes(fakes, log);
  // A stand-in for the caller's home, the shape of a logged-in machine: never the real one.
  const callerHome = path.join(root, 'caller-home');
  for (const directory of ['.codex', '.claude', '.gemini', '.config', '.local/share']) await mkdir(path.join(callerHome, directory), { recursive: true });
  const file = path.join(root, 'reaches-providers.test.js');
  await writeFile(file, `import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
const callerHome = ${JSON.stringify(callerHome)};
test('the run environment reaches no provider', () => {
  assert.notEqual(process.env.HOME, callerHome, 'a private HOME');
  for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME']) assert.ok(process.env[name].startsWith(process.env.HOME + path.sep), name);
  for (const name of ${JSON.stringify(PROVIDER_COMMANDS)}) {
    // By bare name, as the Paseo snapshot, doctor and model probes start them.
    assert.equal(spawnSync(name, ['--version']).error?.code, 'ENOENT', name + ' by bare name');
    // By the path resolved on PATH, as ClaudeTransport starts claude.
    const resolved = process.env.PATH.split(path.delimiter).map(directory => path.join(directory, name)).filter(candidate => { try { accessSync(candidate, constants.X_OK); return true; } catch { return false; } });
    assert.deepEqual(resolved, [], name + ' resolves nowhere on PATH');
  }
  for (const name of ${JSON.stringify(PINNED_PROVIDER_VARIABLES)}) assert.equal(spawnSync(process.env[name], ['--version']).error?.code, 'ENOENT', name);
  assert.equal(process.env.ALP_ANTIGRAVITY_BIN, undefined, 'not pinned: a library provider keeps its configured command');
  // Tools still resolve.
  assert.equal(spawnSync('sh', ['-c', 'exit 0']).status, 0);
});
`);
  const runner = new URL('../../scripts/test-lib.ts', import.meta.url).href;
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${fakes}${path.delimiter}${process.env.PATH}`, HOME: callerHome,
    ALP_CODEX_BIN: path.join(fakes, 'codex'), ALP_CLAUDE_BIN: path.join(fakes, 'claude'), ALP_ANTIGRAVITY_BIN: path.join(fakes, 'agy') };
  delete env.NODE_TEST_CONTEXT;
  const output = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
    `import {runNodeTests} from ${JSON.stringify(runner)};process.exitCode=runNodeTests([${JSON.stringify(file)}],{fileTimeoutMs:30000});`], { env, timeout: 50_000 })
    .catch(error => error);
  assert.ok(output.stderr.includes(`[test-file] PASS ${file}`), output.stderr);
  await assert.rejects(readFile(log, 'utf8'), { code: 'ENOENT' }, 'no recording fake was started');
  assert.deepEqual((await readdir(callerHome)).sort(), ['.claude', '.codex', '.config', '.gemini', '.local'], 'nothing written to the caller home');
  for (const directory of ['.codex', '.claude', '.gemini']) assert.deepEqual(await readdir(path.join(callerHome, directory)), [], directory);
});
