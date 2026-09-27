import os from "node:os";
import path from "node:path";

type Env = Readonly<Record<string, string | undefined>>;

function expandHome(input: string, home: string): string {
  if (input === "~") return home;
  if (input.startsWith("~/")) return path.join(home, input.slice(2));
  return input;
}

/**
 * The daemon resolves its home from `ALP_HOME` (default `~/.alp`), and the plugin subprocess
 * inherits the daemon's environment, so the same rule gives the same directory. Mirrors
 * packages/server/src/server/alp-home.ts; the plugin API does not expose the home directly.
 */
export function resolveAlpHome(env: Env = process.env, home: string = os.homedir()): string {
  return path.resolve(expandHome(env.ALP_HOME ?? "~/.alp", home));
}

/** `$ALP_HOME/supervisor`: the Supervisor system workspace directory. */
export function supervisorDirectory(env: Env = process.env, home: string = os.homedir()): string {
  return path.join(resolveAlpHome(env, home), "supervisor");
}

export function expandUserPath(input: string, home: string = os.homedir()): string {
  return path.resolve(expandHome(input, home));
}

/**
 * The one place that decides whether a directory is the Supervisor system workspace. Workspaces
 * carry no key=value labels, so the path is the identity; the agent inside carries `slp.role`.
 */
export function isSupervisorWorkspace(
  directory: string,
  supervisorDir: string = supervisorDirectory(),
): boolean {
  return expandUserPath(directory) === expandUserPath(supervisorDir);
}
