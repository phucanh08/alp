import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Whether Claude Code can sandbox Bash here: Seatbelt on macOS, bubblewrap and socat on Linux.
 * ALP_CLAUDE_SANDBOX=0 turns it off, =1 claims it (tests). It lives in core so `alp doctor`
 * reads the same answer the runtime acts on: the CLI never loads the runtime (t-b156).
 */
export function claudeSandboxAvailable() {
  if (process.env.ALP_CLAUDE_SANDBOX === '0') return false;
  if (process.env.ALP_CLAUDE_SANDBOX === '1') return true;
  if (process.platform === 'darwin') return existsSync('/usr/bin/sandbox-exec');
  if (process.platform !== 'linux') return false;
  const onPath = (name: string) => (process.env.PATH ?? '').split(path.delimiter).some(dir => dir && existsSync(path.join(dir, name)));
  return onPath('bwrap') && onPath('socat');
}
