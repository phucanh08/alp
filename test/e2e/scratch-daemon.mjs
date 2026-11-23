// Guard for the live lanes that drive a Paseo daemon with real models (t-0336).
//
// These lanes create agents through a Paseo daemon whose ALP plugin runs alpd on an ALP home. If that
// daemon is the user's own (Paseo.app listens on 6767 and its plugin uses ~/.alp), a run drives the
// user's real home: their run logs, lessons, board and sessions. A lane therefore refuses to start
// unless the caller DECLARES the scratch daemon it set up (docs/alp/paseo-plugin.md, "Repeat
// verification"):
//
//   ALP_TEST_ALP_HOME   required: the ALP home that daemon's alpd uses. Refused if it is, contains or
//                       lies inside the real ~/.alp. Run logs are read from <home>/runs.
//   ALP_TEST_PASEO_URL  optional: default ws://127.0.0.1:16767/ws. Refused on port 6767 (Paseo's
//                       default, the user's daemon) and on any non-loopback host.
//   ALP_TEST_PASEO_HOME optional: if given, refused when it is the real ~/.paseo.
//
// The check runs before any connection, file or fixture is made, so a refusal touches nothing.
// It cannot prove which home a daemon really uses; the declaration is the caller's statement, and
// the lanes that read run logs fail afterwards if the logs did not land in the declared home.
import { readdir, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_SCRATCH_URL = 'ws://127.0.0.1:16767/ws';
export const USER_PASEO_PORT = '6767';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * The path with every existing part resolved: realpath of the deepest existing ancestor, then the
 * missing segments as written, so a not-yet-created child of a symlink into ~/.alp still resolves into it.
 */
const canonical = value => {
  let existing = path.resolve(value);
  const missing = [];
  for (;;) {
    try { existing = realpathSync.native(existing); break; } catch {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
  const resolved = path.join(existing, ...missing);
  return process.platform === 'darwin' || process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
/** True when `child` is `parent` or under it; a name such as `..foo` is a child, not an escape. */
const within = (child, parent) => {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
/** Every spelling of the user's home: HOME may be redirected while userInfo still names the real one. */
function userHomes() {
  const homes = new Set();
  for (const read of [() => os.userInfo().homedir, () => os.homedir()]) {
    try { const home = read(); if (home) homes.add(home); } catch { /* no passwd entry */ }
  }
  return [...homes];
}
const overlaps = (candidate, real) => {
  const a = canonical(candidate); const b = canonical(real);
  return within(a, b) || within(b, a);
};

/** The declared scratch daemon, or an Error explaining why the lane must not run. Pure: no I/O but realpath. */
export function scratchDaemon(env = process.env) {
  const refuse = message => new Error(`Refusing to run against a non-scratch Paseo daemon: ${message} See docs/alp/paseo-plugin.md "Repeat verification".`);
  const url = env.ALP_TEST_PASEO_URL || DEFAULT_SCRATCH_URL;
  let parsed;
  try { parsed = new URL(url); } catch { return refuse(`ALP_TEST_PASEO_URL is not a URL (${url}).`); }
  const port = parsed.port || (parsed.protocol === 'wss:' ? '443' : '80');
  if (port === USER_PASEO_PORT) return refuse(`${url} is port ${USER_PASEO_PORT}, the user's own Paseo daemon (its plugin uses the real ~/.alp).`);
  if (!LOOPBACK.has(parsed.hostname)) return refuse(`${url} is not a loopback daemon; only a scratch daemon on this machine can be declared.`);
  const alpHome = env.ALP_TEST_ALP_HOME;
  if (!alpHome) return refuse('ALP_TEST_ALP_HOME is not set. Set it to the scratch ALP home the scratch daemon\'s alpd uses.');
  if (!path.isAbsolute(alpHome)) return refuse(`ALP_TEST_ALP_HOME must be absolute (${alpHome}).`);
  const runLogDir = env.ALP_TEST_RUN_LOG_DIR || path.join(alpHome, 'runs');
  if (!path.isAbsolute(runLogDir)) return refuse(`ALP_TEST_RUN_LOG_DIR must be absolute (${runLogDir}).`);
  for (const home of userHomes()) {
    const realAlp = path.join(home, '.alp');
    if (overlaps(alpHome, realAlp)) return refuse(`ALP_TEST_ALP_HOME (${alpHome}) overlaps the real ALP home ${realAlp}.`);
    if (overlaps(runLogDir, realAlp)) return refuse(`the run log directory (${runLogDir}) overlaps the real ALP home ${realAlp}.`);
    if (env.ALP_TEST_PASEO_HOME && overlaps(env.ALP_TEST_PASEO_HOME, path.join(home, '.paseo'))) return refuse(`ALP_TEST_PASEO_HOME (${env.ALP_TEST_PASEO_HOME}) is the real Paseo home.`);
  }
  return { url, alpHome: path.resolve(alpHome), runLogDir: path.resolve(runLogDir) };
}

/** scratchDaemon() for a lane's entry point: prints the refusal and exits 2 before anything else runs. */
export function requireScratchDaemon(env = process.env) {
  const result = scratchDaemon(env);
  if (result instanceof Error) {
    console.error(result.message);
    process.exit(2);
  }
  return result;
}

/** The run log lines of the root session that worked in `project`, from the scratch home's run logs. */
export async function readRunLog(runLogDir, project) {
  for (const name of await readdir(runLogDir).catch(() => [])) {
    const lines = (await readFile(path.join(runLogDir, name), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    if (lines.some(line => line.project === project)) return lines;
  }
  return [];
}
