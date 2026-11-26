// How the scripts start a command, in one place, so a platform workaround is written once:
//
// - npm and npx are .cmd shims on Windows, which spawn refuses to start without a shell since
//   Node's CVE-2024-27980 fix. There they run as their JavaScript entry under this Node instead.
//   So does pnpm, whose entry is the one that started this script (`pnpm run …` sets npm_execpath).
// - tar on Windows is the system's bsdtar (%SystemRoot%\System32\tar.exe), never whatever comes first
//   on PATH. Under Git Bash (the release workflows' `shell: bash`) that is Git's GNU tar, which reads a
//   drive-letter path such as `D:\a\…\plugin.tgz` as a remote `host:file` archive ("tar (child):
//   Cannot connect to D: resolve failed"), and which cannot write a zip. `--force-local` would fix
//   GNU tar only: bsdtar (macOS, and Windows' tar.exe) rejects it as an unsupported option.
//
// Every other command, and every command elsewhere, is returned as it is.
import { existsSync } from 'node:fs';
import path from 'node:path';

const entries: Record<string,string> = { npm: 'npm-cli.js', npx: 'npx-cli.js' };

/**
 * `pnpm run` hands a script its own settings as npm_config_* variables (globalconfig naming pnpm's
 * rc, node_gyp naming pnpm's copy, node_linker, frozen_lockfile, …). The npm these scripts start as
 * a consumer would read them as its own config and warn on the unknown ones, on stderr that some
 * callers parse with stdout. Removed here, once, before any child starts, so npm sees what it saw
 * under `npm run` or `node scripts/…`. npm_execpath stays: spawnCommand('pnpm') needs it.
 * @returns the removed names
 */
export function clearPnpmConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  if (!/^pnpm\//.test(env.npm_config_user_agent ?? '')) return [];
  const removed = Object.keys(env).filter(key => /^npm_config_/i.test(key));
  for (const key of removed) delete env[key];
  return removed;
}
clearPnpmConfig();

/**
 * Windows' own bsdtar, whatever PATH says.
 *
 * DUPLICATE, deliberately (t-ffe4.6): `systemTar` in packages/cli/src/commands/update/self-update.ts is the same
 * knowledge for the published CLI, which cannot import from scripts/. Change one and change the
 * other; test/integration/spawn-command.test.ts asserts the two agree, and refuses any third copy.
 */
export const windowsTar = (env = process.env) => path.win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

/**
 * Returns `[file, args]` for spawn/spawnSync.
 */
export function spawnCommand(name: string, args: readonly string[]): [string,readonly string[]] {
  if (process.platform !== 'win32') return [name, args];
  if (name === 'tar') return [windowsTar(), args];
  if (name === 'pnpm') {
    const entry = process.env.npm_execpath;
    if (!entry || !/pnpm\.c?js$/.test(entry)) throw new Error('pnpm on Windows: start this script through pnpm (pnpm run …), which names its entry in npm_execpath');
    return [process.execPath, [entry, ...args]];
  }
  if (!entries[name]) return [name, args];
  const fromNpm = name === 'npm' && process.env.npm_execpath?.endsWith(entries.npm) ? process.env.npm_execpath : undefined;
  const entry = fromNpm ?? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', entries[name]);
  if (!existsSync(entry)) throw new Error(`${name} not found next to ${process.execPath}; expected ${entry}`);
  // Package scripts here and upstream chain with `&&`, which a user's script-shell of Windows
  // PowerShell 5 cannot parse; cmd.exe can, so these runs use it whatever the user's npmrc says.
  const shell = name === 'npm' ? [`--script-shell=${process.env.ComSpec ?? 'cmd.exe'}`] : [];
  return [process.execPath, [entry, ...shell, ...args]];
}

/**
 * How a finished spawnSync failed: its error (not started, timed out, output too large), signal or exit status.
 */
export function exitDescription(result: { error?: Error; signal?: NodeJS.Signals|null; status?: number|null; }) {
  if (result.error) return `could not run to completion: ${result.error.message}`;
  return result.signal ? `was killed by ${result.signal}` : `exited ${result.status}`;
}
