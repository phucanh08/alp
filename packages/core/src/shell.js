import { execFile, spawn } from 'node:child_process';

/**
 * Starts `command` through the platform's shell: /bin/sh -c in its own process group, or on
 * Windows cmd.exe /d /s /c with the line quoted whole (cmd strips only the outermost quotes,
 * and Node would otherwise escape the quotes inside it).
 * @param {string} command
 * @param {import('node:child_process').SpawnOptions} options
 */
export function spawnShell(command, options) {
  if (process.platform !== 'win32') return spawn('/bin/sh', ['-c', command], { ...options, detached: true });
  return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], { ...options, windowsHide: true, windowsVerbatimArguments: true });
}

/**
 * Signals a command `spawnShell` started and everything it started. Windows has no signals and
 * cmd.exe's children outlive it, so there the whole tree is ended at once by the first signal
 * and no cleanup runs.
 * @param {import('node:child_process').ChildProcess} child
 * @param {NodeJS.Signals} name
 */
export function signalShell(child, name) {
  if (process.platform === 'win32') {
    if (name === 'SIGTERM') execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    return;
  }
  try { process.kill(-child.pid, name); } catch { child.kill(name); }
}
