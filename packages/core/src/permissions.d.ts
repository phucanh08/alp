export type PermissionBase = 'read-only' | 'workspace-write' | 'full-access';
export type PermissionProfile = { name: string; base: PermissionBase; allow: string[]; ask: string[]; deny: string[]; beyondMode: 'refuse' | 'ask'; workdir?: 'copy'; cappedFrom?: PermissionBase };
export const BASES: PermissionBase[];
export const ADVISORS: string[];
export const READ_ONLY_ROLES: string[];
export const MAX_RULES: number;
export const TOOLS: string[];
export function parseRule(rule: unknown, source?: string): { tool: string; specifier?: string };
export function validatePermissions(value: unknown, source: string): { profiles: Record<string, { base?: PermissionBase; beyondMode?: 'refuse' | 'ask'; workdir?: 'copy'; allow: string[]; ask: string[]; deny: string[] }>; agents: Record<string, string> };
export function addAllowRule(projectRoot: string, home: string | undefined, profileName: string, rule: string): Promise<string>;
export function profileFor(projectRoot: string, home: string | undefined, agent: string, options?: { readOnly?: boolean }): Promise<PermissionProfile | null>;
export type PermissionScopeName = 'project' | 'user';
export type PermissionSource = { scope: PermissionScopeName; file: string };
export type PermissionScope = PermissionSource & { exists: boolean; profiles: ReturnType<typeof validatePermissions>['profiles']; agents: Record<string, string> };
/** Where one resolved value came from: a settings file, or ALP's default when no file sets it. */
export type PermissionOrigin<T> = { value: T; key?: string; reason?: string } & (PermissionSource | { scope: 'default' });
export type PermissionRuleOrigin = { rule: string; sources: PermissionSource[] };
export type PermissionProvenance = {
  name: PermissionOrigin<string> & { overrides?: Array<PermissionSource & { value: string }> };
  base: PermissionOrigin<PermissionBase> & { cappedFrom?: PermissionBase };
  beyondMode: PermissionOrigin<'refuse' | 'ask'>;
  workdir?: PermissionOrigin<'copy'>;
  allow: PermissionRuleOrigin[]; ask: PermissionRuleOrigin[]; deny: PermissionRuleOrigin[];
};
export type PermissionWarning = { code: 'project-base-higher' | 'project-allow-rules' | 'project-beyond-mode' | 'user-deny-not-applied' | 'user-ask-not-applied'; agent: string; message: string; rules?: string[]; project?: PermissionBase; user?: PermissionBase };
export type PermissionExplanation = {
  agent: string;
  profile: PermissionProfile | null;
  provenance: PermissionProvenance | null;
  scopes: Array<PermissionSource & { exists: boolean; agentProfile?: string; profile?: ReturnType<typeof validatePermissions>['profiles'][string] }>;
  warnings: PermissionWarning[];
};
export function permissionScopes(projectRoot: string, home: string | undefined): Promise<PermissionScope[]>;
export function explainProfile(projectRoot: string, home: string | undefined, agent: string, options?: { readOnly?: boolean }): Promise<PermissionExplanation>;
export function capMode(mode: string, base: string): string;
export function unwrapShell(command: string): string;
export function simpleCommands(line: string): string[] | null;
export function plainCommands(line: string): string[] | null;
export function commandDecision(profile: Pick<PermissionProfile, 'allow' | 'deny'> & { ask?: string[] }, command: string): 'allow' | 'ask' | 'deny' | undefined;
