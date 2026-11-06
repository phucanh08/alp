// How the scripts start a command, in one place, so a platform workaround is written once:
//
// - npm and npx are .cmd shims on Windows, which spawn refuses to start without a shell since
//   Node's CVE-2024-27980 fix. There they run as their JavaScript entry under this Node instead.
// - tar on Windows is the system's bsdtar (%SystemRoot%\System32\tar.exe), never whatever comes first
//   on PATH. Under Git Bash (the release workflows' `shell: bash`) that is Git's GNU tar, which reads a
//   drive-letter path such as `D:\a\…\plugin.tgz` as a remote `host:file` archive ("tar (child):
//   Cannot connect to D: resolve failed"), and which cannot write a zip. `--force-local` would fix
//   GNU tar only: bsdtar (macOS, and Windows' tar.exe) rejects it as an unsupported option.
//
// Every other command, and every command elsewhere, is returned as it is.
import { existsSync } from 'node:fs';
import path from 'node:path';

const entries = { npm: 'npm-cli.js', npx: 'npx-cli.js' };

/** Windows' own bsdtar, whatever PATH says. */
export const windowsTar = (env = process.env) => path.win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');

/** Returns `[file, args]` for spawn/spawnSync. */
export function spawnCommand(name, args) {
  if (process.platform !== 'win32') return [name, args];
  if (name === 'tar') return [windowsTar(), args];
  if (!entries[name]) return [name, args];
  const fromNpm = name === 'npm' && process.env.npm_execpath?.endsWith(entries.npm) ? process.env.npm_execpath : undefined;
  const entry = fromNpm ?? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', entries[name]);
  if (!existsSync(entry)) throw new Error(`${name} not found next to ${process.execPath}; expected ${entry}`);
  // Package scripts here and upstream chain with `&&`, which a user's script-shell of Windows
  // PowerShell 5 cannot parse; cmd.exe can, so these runs use it whatever the user's npmrc says.
  const shell = name === 'npm' ? [`--script-shell=${process.env.ComSpec ?? 'cmd.exe'}`] : [];
  return [process.execPath, [entry, ...shell, ...args]];
}

/** How a finished spawnSync failed: its error (not started, timed out, output too large), signal or exit status. */
export function exitDescription(result) {
  if (result.error) return `could not run to completion: ${result.error.message}`;
  return result.signal ? `was killed by ${result.signal}` : `exited ${result.status}`;
}
