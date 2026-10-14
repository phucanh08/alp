export interface AgentModelConfig { provider?: 'codex' | 'claude' | 'acp' | 'antigravity'; model?: string; effort?: string }
export type AutoCompact = 'auto' | number;
export type AgentProfilesConfig = {
  /** "provider:model", "provider:*" for any model of that provider, or the earlier object form. */
  profiles?: Array<string | AgentModelConfig>;
  autocompact?: AutoCompact;
  claude?: AgentModelConfig;
  codex?: AgentModelConfig;
} & AgentModelConfig;
/** Disk configuration; no provider SDK types. */
export interface RawSettings {
  team?: Record<string, Record<string, AgentProfilesConfig>>;
  /** Legacy settings key; use team. */
  profile?: Record<string, Record<string, AgentProfilesConfig>>;
  defaultAgent?: string;
  workflow?: { mode?: 'pho' | 'cafe' | 'smart' | 'supervised'; maxPeers?: number; supervisor?: boolean };
  delegation?: Record<string, string[]>;
  runtime?: { provider?: string; model?: string; reasoning?: string };
}
export interface RawMcpServer {
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}
export interface RawMcpConfig { mcpServers?: Record<string, RawMcpServer> }
export interface ResolvedResource { name: string; path: string }
export interface ResolvedMcpConfig { mcpServers: Record<string, RawMcpServer> }
/** JSON-serializable adapter input. All filesystem resource paths/cwd are absolute. */
export interface ResolvedAgent {
  name: string;
  projectRoot: string;
  instructions: { project: string; agent: string };
  skills: ResolvedResource[];
  hooks: ResolvedResource[];
  mcp: ResolvedMcpConfig;
  runtime: { provider?: string; model?: string; reasoning?: string };
  /** The part of runtime that settings.json sets for every agent; it comes before a team's or the agent's choice. */
  projectRuntime?: { provider?: string; model?: string; reasoning?: string };
  /** Where the agent is defined: ALP's built-ins, the user's library, or the project (ALPD §41). */
  source?: 'builtin' | 'library' | 'project';
  /** The permission mode the agent runs in unless its caller asks for another. */
  mode?: 'read-only' | 'workspace-write' | 'full-access';
  description?: string;
  /** The context window it works in before its runtime compacts, in tokens; absent: the model's (ALPD §57). */
  context?: number;
  autocompact?: AutoCompact;
}
