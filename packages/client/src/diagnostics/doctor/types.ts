import type { CommandRunner } from '../../_shared/command.ts';

/** One finding of alp doctor; `fix` is what --fix may do about it. */
export type DoctorCheck = {
  id: string;
  status: 'ok' | 'info' | 'warn' | 'fail';
  summary: string;
  details?: string[];
  hint?: string;
  fix?: { describe: string; apply(): Promise<string> };
};
export type LeftoverState = 'clean-pushed' | 'dirty' | 'local-only' | 'unpushed' | 'in-use' | 'unknown';
export type Leftover = { path: string; state: LeftoverState; reason?: string; command?: string };
export type DiagnoseOptions = { home?: string; project?: string; env?: NodeJS.ProcessEnv; run?: CommandRunner; sandbox?: boolean; daemonEntry?: string; timeoutMs?: number };
export type DiskCheckOptions = { run?: CommandRunner; env?: NodeJS.ProcessEnv; free?: number; tempDirs?: string[]; cwd?: string; classifyMs?: number; recentMs?: number; platform?: NodeJS.Platform };
