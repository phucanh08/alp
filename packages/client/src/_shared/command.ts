import { spawn } from 'node:child_process';
import { scriptCommand } from '@anhlp/alp-core/packaged';

export type CommandResult = { code: number; stdout: string; stderr: string };
export type CommandOptions = { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number };
export type CommandRunner = (command: string, args: string[], options?: CommandOptions) => Promise<CommandResult>;

/** Runs a command; resolves with its exit code and output, never rejects. */
export function runCommand(command: string, args: string[], { cwd, env = process.env, timeoutMs = 15_000 }: CommandOptions = {}): Promise<CommandResult> {
  return new Promise(resolve => {
    let child;
    // Windows cannot exec a script by its shebang; a JavaScript command runs under this Node, as the Codex transport does.
    const script = process.platform === 'win32' && /\.[cm]?js$/i.test(command);
    const run: { command: string; args: string[]; env?: Record<string, string> } = script ? scriptCommand(command, args) : { command, args };
    try { child = spawn(run.command, run.args, { cwd, env: run.env ? { ...env, ...run.env } : env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { resolve({ code: -1, stdout: '', stderr: (error as Error).message }); return; }
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', error => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: error.message }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}
