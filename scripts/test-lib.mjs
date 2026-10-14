import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const packages = ['protocol', 'core', 'runtime', 'client', 'daemon', 'cli', 'paseo'];
/** Where each workspace lives: libraries under packages/, external integrations under integrations/, apps under apps/. */
export const locations = { paseo: 'integrations/paseo', tui: 'apps/tui' };
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
}

/** Runs the files with `node --test` against a throwaway ALP_HOME, so no run touches the user's ~/.alp. */
export function runNodeTests(files, { extra = [] } = {}) {
  if (!files.length) throw new Error('no test files selected');
  const home = mkdtempSync(path.join(os.tmpdir(), 'alp-test-'));
  try {
    const result = spawnSync(process.execPath, ['--test', ...extra, ...files], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ALP_HOME: home } });
    return result.status ?? 1;
  } finally { rmSync(home, { recursive: true, force: true }); }
}
