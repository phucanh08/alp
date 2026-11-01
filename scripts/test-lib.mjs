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

/** Runs the files with `node --test` against a throwaway ALP_HOME, so no run touches the user's ~/.alp. */
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

export function runNodeTests(files, { extra = [] } = {}) {
  if (!files.length) throw new Error('no test files selected');
  const home = mkdtempSync(path.join(os.tmpdir(), 'alp-test-'));
  try {
    // alpd under test never asks the real providers for models (t-e5ee); a test that wants it unsets this.
    // A hung test fails after 5 minutes instead of stalling the CI job until its timeout (t-ffbd).
    const result = spawnSync(process.execPath, ['--test', '--test-timeout=300000', ...extra, ...files], { cwd: ROOT, stdio: 'inherit', env: { ALP_MODEL_CATALOG: 'static', ...hermeticEnv(), ALP_HOME: home } });
    return result.status ?? 1;
  } finally { rmSync(home, { recursive: true, force: true }); }
}
