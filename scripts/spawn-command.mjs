// npm and npx are .cmd shims on Windows, which spawn refuses to start without a shell since
// Node's CVE-2024-27980 fix. There they run as their JavaScript entry under this Node instead;
// every other command, and every command elsewhere, is returned as it is.
import { existsSync } from 'node:fs';
import path from 'node:path';

const entries = { npm: 'npm-cli.js', npx: 'npx-cli.js' };

/** Returns `[file, args]` for spawn/spawnSync. */
export function spawnCommand(name, args) {
  if (process.platform !== 'win32' || !entries[name]) return [name, args];
  const fromNpm = name === 'npm' && process.env.npm_execpath?.endsWith(entries.npm) ? process.env.npm_execpath : undefined;
  const entry = fromNpm ?? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', entries[name]);
  if (!existsSync(entry)) throw new Error(`${name} not found next to ${process.execPath}; expected ${entry}`);
  // Package scripts here and upstream chain with `&&`, which a user's script-shell of Windows
  // PowerShell 5 cannot parse; cmd.exe can, so these runs use it whatever the user's npmrc says.
  const shell = name === 'npm' ? [`--script-shell=${process.env.ComSpec ?? 'cmd.exe'}`] : [];
  return [process.execPath, [entry, ...shell, ...args]];
}
