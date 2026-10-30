import { spawn } from 'node:child_process';
import { scriptCommand } from '@anhlp/alp-core/packaged';

/** Runs a command; resolves with its exit code and output, never rejects. */
export function runCommand(command, args, { cwd, env = process.env, timeoutMs = 15_000 } = {}) {
  return new Promise(resolve => {
    let child;
    // Windows cannot exec a script by its shebang; a JavaScript command runs under this Node, as the Codex transport does.
    const script = process.platform === 'win32' && /\.[cm]?js$/i.test(command);
    const run = script ? scriptCommand(command, args) : { command, args };
    try { child = spawn(run.command, run.args, { cwd, env: run.env ? { ...env, ...run.env } : env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { resolve({ code: -1, stdout: '', stderr: error.message }); return; }
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', error => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: error.message }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}
