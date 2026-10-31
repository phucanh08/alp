export type DoctorCheck = {
  id: string;
  status: 'ok' | 'info' | 'warn' | 'fail';
  summary: string;
  details?: string[];
  hint?: string;
  fix?: { describe: string; apply(): Promise<string> };
};
export type CommandResult = { code: number; stdout: string; stderr: string };
export type CommandRunner = (command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }) => Promise<CommandResult>;
export const runCommand: CommandRunner;
export function diagnose(options?: { home?: string; project?: string; env?: NodeJS.ProcessEnv; run?: CommandRunner; sandbox?: boolean; daemonEntry?: string; timeoutMs?: number }): Promise<DoctorCheck[]>;
export type LeftoverState = 'clean-pushed' | 'dirty' | 'unpushed' | 'in-use' | 'unknown';
export type Leftover = { path: string; state: LeftoverState; reason?: string; command?: string };
export const LEFTOVER_STATES: Record<LeftoverState, string>;
export function diskCheck(home: string, options?: { run?: CommandRunner; env?: NodeJS.ProcessEnv; free?: number; tempDirs?: string[]; cwd?: string; classifyMs?: number; recentMs?: number }): Promise<DoctorCheck & { leftovers?: Leftover[] }>;
export function repair(checks: DoctorCheck[]): Promise<Array<{ id: string; result: string }>>;
