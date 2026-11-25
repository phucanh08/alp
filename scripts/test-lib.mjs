// @ts-check
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const packages = ['protocol', 'core', 'runtime', 'client', 'daemon', 'cli', 'gateway', 'paseo'];
/** Where each workspace lives: libraries under packages/, external integrations under integrations/, apps under apps/. */
/** @type {Record<string, string>} */
export const locations = { paseo: 'integrations/paseo', tui: 'apps/tui', gateway: 'apps/gateway' };
export const workspaceDirectory = /** @param {string} name */ name => locations[name] ?? `packages/${name}`;

/**
 * Every `*.test.js` under `directory`, relative to the repository root; none if it does not exist.
 * @param {string} directory
 * @returns {string[]}
 */
export function testFiles(directory) {
  const absolute = path.join(ROOT, directory);
  try {
    // Without an encoding readdirSync lists names as strings; its recursive overload types them loosely.
    return /** @type {string[]} */ (readdirSync(absolute, { recursive: true }))
      .filter(file => file.endsWith('.test.js'))
      .map(file => path.join(directory, file).split(path.sep).join('/'))
      .sort();
  } catch { return []; }
}

export const packageTests = /** @param {string} name */ name => testFiles(`${workspaceDirectory(name)}/tests`);
export const integrationTests = () => testFiles('test/integration');
/** The browser app's unit tests (apps/web): not a library workspace, run as a group of their own. */
export const webTests = () => testFiles('apps/web/tests');

/** @param {string} script @param {string[]} args */
function step(script, ...args) {
  const result = spawnSync(process.execPath, [path.join(ROOT, script), ...args], { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/** Builds `name` and, recursively, the workspaces it depends on (the plugin also builds the root bundles). */
/** @param {string} name */
export function buildWorkspace(name) { step('scripts/build-workspace.mjs', name); }

/** Builds every workspace, as the suites that cross packages need all of their artifacts. */
export function buildAll() {
  buildWorkspace('paseo');
  buildWorkspace('cli');
  buildWorkspace('gateway');
  // The web app's src/lib as JavaScript (apps/web/dist-lib): its unit tests and an integration test load it.
  step('apps/web/scripts/build-lib.mjs');
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

/**
 * The same isolation for a whole process rather than one child: removes the caller's ALP session
 * variables from `env` IN PLACE and returns the names it removed, so the caller can say so.
 *
 * For a wrapper that spawns its steps without passing an env (scripts/validate.mjs): every child
 * then inherits the cleaned environment, and no step has to remember (t-5294.3, t-3a63). The
 * product guards are untouched — a real agent process still announces itself and is still refused
 * the user's methods. What this undoes is only the accident that a VERIFICATION run inherits the
 * session of the shell that started it, which made `alp dashboard --print` in core-standalone-smoke.mjs
 * and the installed plugin regressions in tarball-consumer.mjs refuse to run for any agent.
 */
export function clearCallerSession(env = process.env) {
  const removed = CALLER_SESSION_VARIABLES.filter(name => env[name] !== undefined);
  for (const name of removed) delete env[name];
  return removed;
}

/** ALP_CODEX_BIN, ALP_CLAUDE_BIN, ALP_GH_BIN, ...: the caller's provider and tool executables. */
export const isCallerBinary = /** @param {string} name */ name => /^ALP_[A-Z0-9_]+_BIN$/i.test(name);

/**
 * The POSIX base directories a program looks in INSTEAD of `$HOME/.config` and friends when they are
 * set (t-d05e). Redirecting HOME alone leaves them pointing at the user's real directories, and this
 * repository has a consumer that reads one: packages/client/src/service.ts resolves the systemd user
 * unit directory to `XDG_CONFIG_HOME/systemd/user`, so a private-home run that installed a service
 * without ALP_SERVICE_DIR would write a unit into the USER's ~/.config. XDG_RUNTIME_DIR is
 * deliberately NOT here: it is a 0700 directory systemd owns and uses for sockets, and handing a
 * test one we made would change socket behaviour rather than isolate it.
 */
export const XDG_BASE_DIRECTORIES = { XDG_CONFIG_HOME: '.config', XDG_DATA_HOME: path.join('.local', 'share'), XDG_CACHE_HOME: '.cache' };

/**
 * Redirect home/profile-based discovery to the private home (t-bfbd), removing
 * caller ALP_*_BIN overrides. PATH stays available for normal tool execution.
 * This is test environment isolation, not a filesystem sandbox.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} home
 * @returns {NodeJS.ProcessEnv}
 */
export function homelessEnv(env, home) {
  const result = { ...env };
  // Windows names are case-insensitive: drop every spelling so the child sees only the private one.
  // HOMESHARE is the network home a Windows domain profile defines; os.homedir() does not read it,
  // but a tool that does would reach past the private profile to the user's real one (t-d05e).
  for (const name of Object.keys(result)) if (isCallerBinary(name) || /^(HOME|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|HOMESHARE)$/i.test(name)) delete result[name];
  // Use the private profile for Windows consumers that bypass os.homedir().
  // A drive/UNC home also defines the legacy HOMEDRIVE + HOMEPATH pair.
  const windowsRoot = path.win32.parse(home).root;
  const drive = windowsRoot.includes('\\') ? windowsRoot.replace(/[\\/]$/, '') : '';
  const profilePath = drive ? path.win32 : path;
  return { ...result, HOME: home, USERPROFILE: home,
    APPDATA: profilePath.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: profilePath.join(home, 'AppData', 'Local'),
    // Set, not deleted: unset means "use $HOME/.config", which is already the private home, but an
    // inherited value would survive the deletion of HOME and must be overwritten.
    ...Object.fromEntries(Object.entries(XDG_BASE_DIRECTORIES).map(([name, relative]) => [name, profilePath.join(home, relative)])),
    ...(drive ? { HOMEDRIVE: drive, HOMEPATH: home.slice(drive.length) || '\\' } : {}),
  };
}

/**
 * The commands that start an AI provider ALP drives or probes (t-a87f). On a developer's machine they
 * are installed and logged in, and code under test reaches them by bare name: the Paseo provider
 * snapshot runs `codex --version` / `claude --version` (integrations/paseo/server/paseo/providers.ts),
 * `alp doctor` runs `codex login status`, `claude auth status`, `agy models`, an alpd started by a test
 * runs `codex app-server` and the Claude model probe, and ClaudeTransport resolves `claude` on PATH to
 * its real path before starting it. A test run must reach none of them: CI has none installed, and
 * that absence is the behaviour the suites are written for.
 */
export const PROVIDER_COMMANDS = ['agy', 'claude', 'codex', 'gemini', 'opencode'];

/**
 * Provider executables the run pins to a path that does not exist, so that code reading them (the
 * Paseo snapshot, doctor, model probes, alpd's transports) cannot start a provider either by the
 * variable or by falling back to the bare name. ALP_ANTIGRAVITY_BIN is deliberately NOT pinned: it
 * overrides the command a library provider configures (packages/runtime/src/providers.ts), so pinning
 * it would also disable the fake agy test/integration/antigravity.test.js configures; `agy` is kept
 * out by the PATH guard instead (providerFreePath).
 */
export const PINNED_PROVIDER_VARIABLES = ['ALP_CODEX_BIN', 'ALP_CLAUDE_BIN'];

/** Whether a directory entry is a provider command: any case (case-insensitive file systems), and on Windows with an executable extension. */
const isProviderEntry = /** @param {string} entry @param {NodeJS.Platform} platform */ (entry, platform) => {
  const name = entry.toLowerCase();
  return PROVIDER_COMMANDS.some(command => name === command || (platform === 'win32' && /^\.(exe|cmd|bat|ps1|com)$/.test(name.slice(command.length)) && name.startsWith(command)));
};

/**
 * `searchPath` with every provider command taken out of it (t-a87f): a directory that holds none is
 * kept as it is; one that holds a provider (/usr/local/bin with node and codex, ~/.local/bin with
 * claude and agy) is replaced by a shadow directory under `shadowRoot` that links every OTHER entry,
 * so node, git and the rest still resolve while `codex`, `claude`, `agy`, ... resolve to nothing, as
 * on CI. A test that wants a provider puts its own fake first on its child's PATH, which still works.
 * An entry that cannot be linked is left out of the shadow rather than reaching the original, and a
 * directory that cannot be listed is left out of PATH.
 * @param {string | undefined} searchPath
 * @param {string} shadowRoot
 * @param {{ platform?: NodeJS.Platform }} [options]
 */
export function providerFreePath(searchPath, shadowRoot, { platform = process.platform } = {}) {
  const delimiter = platform === 'win32' ? ';' : ':';
  const result = [];
  let shadows = 0;
  for (const directory of (searchPath ?? '').split(delimiter)) {
    if (!directory) continue;
    let entries;
    // Fail closed: a directory that cannot be listed (missing, not a directory, execute-only) may hold a
    // provider this run cannot see, so it is dropped rather than kept as it is.
    try { entries = readdirSync(directory); } catch { continue; }
    if (!entries.some(entry => isProviderEntry(entry, platform))) { result.push(directory); continue; }
    const shadow = path.join(shadowRoot, String(shadows++));
    mkdirSync(shadow, { recursive: true });
    for (const entry of entries) {
      if (isProviderEntry(entry, platform)) continue;
      try { symlinkSync(path.join(directory, entry), path.join(shadow, entry)); } catch {}
    }
    result.push(shadow);
  }
  return result.join(delimiter);
}

/**
 * The environment of a test run (t-a87f): the caller's without its ALP session (hermeticEnv), a
 * private HOME/USERPROFILE/XDG profile `user` with no caller ALP_*_BIN (homelessEnv), the provider
 * executables pinned under `scratch` to a path that does not exist, and a PATH without any provider
 * command (providerFreePath). Only the test environment changes; the code under test is untouched.
 * @param {{ env?: NodeJS.ProcessEnv, user: string, scratch: string, platform?: NodeJS.Platform }} options
 */
export function testRunEnv({ env = process.env, user, scratch, platform = process.platform }) {
  const base = homelessEnv(hermeticEnv(env), user);
  const pathKey = Object.keys(base).find(name => /^path$/i.test(name)) ?? 'PATH';
  base[pathKey] = providerFreePath(base[pathKey], path.join(scratch, 'provider-free-path'), { platform });
  for (const name of PINNED_PROVIDER_VARIABLES) base[name] = path.join(scratch, 'no-provider', name.toLowerCase());
  return base;
}

/**
 * Runs the files with `node --test` against a throwaway ALP_HOME and TMPDIR, without the caller's
 * ALP session variables, so no run touches the user's ~/.alp or leaves directories in the temp dir.
 * Every run also gets a throwaway HOME/USERPROFILE/XDG profile, no caller ALP_*_BIN, provider
 * executables pinned to a missing path and a PATH without provider commands (testRunEnv, t-a87f): on
 * a machine where agy, codex, claude and opencode are installed and logged in, no test reaches them.
 * `privateHome` is accepted for the callers that still pass it (the windows-daemon CI lane, t-bfbd);
 * the private home is now always given.
 * Each file reports START/PASS/FAIL and has a hard `fileTimeoutMs` (default five
 * minutes), including leaked handles after tests finish. Normal files run without
 * process instrumentation. Timeout termination is best effort for the held root/group;
 * detached descendants may survive. Timeout or coordinator failure retains all scratch.
 * @param {string[]} files
 * @param {{ extra?: string[], fileTimeoutMs?: number, privateHome?: boolean }} [options] privateHome is accepted and ignored (see above)
 */
export function runNodeTests(files, { extra = [], fileTimeoutMs = 300_000 } = {}) {
  if (!files.length) throw new Error('no test files selected');
  if (!Number.isSafeInteger(fileTimeoutMs) || fileTimeoutMs <= 0 || fileTimeoutMs > 2_147_483_647) throw new Error('fileTimeoutMs must be a positive timer interval');
  const home = mkdtempSync(path.join(os.tmpdir(), 'alp-test-'));
  const user = mkdtempSync(path.join(os.tmpdir(), 'alpu-'));
  // Every temporary directory the tests (and alpd, providers and Node under them) make goes in one
  // scratch directory that is removed afterwards, also when a test forgets its own (t-bf7f). Short:
  // Unix socket paths under it must stay below 104 bytes on macOS.
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'alpt-'));
  const retain = path.join(scratch, 'cleanup-unconfirmed');
  // Fail closed if the coordinator crashes or is interrupted before completion.
  writeFileSync(retain, 'cleanup pending\n');
  try {
    // alpd under test never asks the real providers for models (t-e5ee); a test that wants it unsets this.
    // A per-file hard watchdog also cuts off leaked handles after five minutes.
    const base = testRunEnv({ user, scratch });
    for (const directory of [base.APPDATA, base.LOCALAPPDATA, ...Object.keys(XDG_BASE_DIRECTORIES).map(name => base[name])]) mkdirSync(/** @type {string} */ (directory), { recursive: true }); // homelessEnv sets every one of them
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/test-file-watchdog.mjs'), JSON.stringify({ files, extra, fileTimeoutMs })], { cwd: ROOT, stdio: 'inherit', env: { ALP_MODEL_CATALOG: 'static', ...base, ALP_TEST_RETAIN: retain, ALP_HOME: home, TMPDIR: scratch, TMP: scratch, TEMP: scratch } });
    if (result.error || result.signal || result.status === null) writeFileSync(retain, 'coordinator failed\n');
    return result.status ?? 1;
  } finally {
    if (existsSync(retain)) {
      console.warn(`warning: cleanup unconfirmed; retained ${[home, scratch, user].filter(Boolean).join(', ')}`);
    }
    // A directory a lingering child still holds must not turn a passing run into a failure.
    for (const dir of (existsSync(retain) ? [] : [home, scratch, user].filter(Boolean))) {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
      catch (error) { console.warn(`warning: could not remove ${dir}: ${/** @type {Error} */ (error).message}`); }
    }
  }
}
