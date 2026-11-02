import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const packages = ['protocol', 'core', 'runtime', 'client', 'daemon', 'cli', 'gateway', 'paseo'];
/** Where each workspace lives: libraries under packages/, external integrations under integrations/, apps under apps/. */
export const locations = { paseo: 'integrations/paseo', tui: 'apps/tui', gateway: 'apps/gateway' };
export const workspaceDirectory = name => locations[name] ?? `packages/${name}`;

/** Every `*.test.js` under `directory`, relative to the repository root; none if it does not exist. */
export function testFiles(directory) {
  const absolute = path.join(ROOT, directory);
  try {
    return readdirSync(absolute, { recursive: true })
      .filter(file => file.endsWith('.test.js'))
      .map(file => path.join(directory, file).split(path.sep).join('/'))
      .sort();
  } catch { return []; }
}

export const packageTests = name => testFiles(`${workspaceDirectory(name)}/tests`);
export const integrationTests = () => testFiles('test/integration');
/** The browser app's unit tests (apps/web): not a library workspace, run as a group of their own. */
export const webTests = () => testFiles('apps/web/tests');

function step(script, ...args) {
  const result = spawnSync(process.execPath, [path.join(ROOT, script), ...args], { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/** Builds `name` and, recursively, the workspaces it depends on (the plugin also builds the root bundles). */
export function buildWorkspace(name) { step('scripts/build-workspace.mjs', name); }

/** Builds every workspace, as the suites that cross packages need all of their artifacts. */
export function buildAll() {
  buildWorkspace('paseo');
  buildWorkspace('cli');
  buildWorkspace('gateway');
}

/**
 * Variables an ALP agent's shell (or an installed ALP) sets that would change what the code under
 * test does: a test run started from an agent's terminal must behave as one started by the user
 * (t-bf7f). ALP_AGENT_SESSION makes every client connect as an agent (user_only methods refuse it).
 */
export const CALLER_SESSION_VARIABLES = ['ALP_AGENT_SESSION', 'ALP_BRIDGE_SOCKET', 'ALP_BRIDGE_TOKEN', 'ALP_DAEMON_ENTRY', 'ALP_INTEGRATION_ENTRY', 'ALP_RUN_LOG_DIR'];

/** process.env without the caller's ALP session variables. */
export function hermeticEnv(env = process.env) {
  const result = { ...env };
  for (const name of CALLER_SESSION_VARIABLES) delete result[name];
  return result;
}

/** ALP_CODEX_BIN, ALP_CLAUDE_BIN, ALP_GH_BIN, ...: the caller's provider and tool executables. */
export const isCallerBinary = name => /^ALP_[A-Z0-9_]+_BIN$/i.test(name);

/**
 * `env` that also cannot reach the caller's own installation (t-bfbd): no ALP_*_BIN overrides and a
 * private home, so the code under test does not find the caller's providers or ~/.alp/bin through
 * os.homedir(), which is USERPROFILE on Windows and HOME elsewhere.
 */
export function homelessEnv(env, home) {
  const result = { ...env };
  // Windows names are case-insensitive: drop every spelling so the child sees only the private one.
  for (const name of Object.keys(result)) if (isCallerBinary(name) || /^(HOME|USERPROFILE)$/i.test(name)) delete result[name];
  return { ...result, HOME: home, USERPROFILE: home };
}

/**
 * Runs the files with `node --test` against a throwaway ALP_HOME and TMPDIR, without the caller's
 * ALP session variables, so no run touches the user's ~/.alp or leaves directories in the temp dir.
 * `privateHome` also removes ALP_*_BIN and gives the run a throwaway HOME/USERPROFILE (homelessEnv):
 * the windows-daemon CI lane runs that way (t-bfbd).
 */
export function runNodeTests(files, { extra = [], privateHome = false } = {}) {
  if (!files.length) throw new Error('no test files selected');
  const home = mkdtempSync(path.join(os.tmpdir(), 'alp-test-'));
  const user = privateHome ? mkdtempSync(path.join(os.tmpdir(), 'alpu-')) : undefined;
  // Every temporary directory the tests (and alpd, providers and Node under them) make goes in one
  // scratch directory that is removed afterwards, also when a test forgets its own (t-bf7f). Short:
  // Unix socket paths under it must stay below 104 bytes on macOS.
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'alpt-'));
  try {
    // alpd under test never asks the real providers for models (t-e5ee); a test that wants it unsets this.
    // A hung test fails after 5 minutes instead of stalling the CI job until its timeout (t-ffbd).
    const base = user ? homelessEnv(hermeticEnv(), user) : hermeticEnv();
    const result = spawnSync(process.execPath, ['--test', '--test-timeout=300000', ...extra, ...files], { cwd: ROOT, stdio: 'inherit', env: { ALP_MODEL_CATALOG: 'static', ...base, ALP_HOME: home, TMPDIR: scratch, TMP: scratch, TEMP: scratch } });
    return result.status ?? 1;
  } finally {
    // A directory a lingering child still holds must not turn a passing run into a failure.
    for (const dir of [home, scratch, user].filter(Boolean)) {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
      catch (error) { console.warn(`warning: could not remove ${dir}: ${error.message}`); }
    }
  }
}
