import type { PluginBeforeRequests } from "@getpaseo/plugin/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { BUNDLED_DEFINITIONS } from "./definitions.gen";
import { runtimeBlock } from "./runtime-block";

export type Seat = "lead" | "peer" | "supervisor";

/** providerOptions of an agent config, taken from the hook type so the plugin needs no extra deps. */
export type ProviderOptions = PluginBeforeRequests["agent.create"]["config"]["providerOptions"];

/** Base provider an SLP seat runs on: decides which providerOptions mean anything. */
export type Family = "claude" | "codex";

/** Agent label that names the seat. */
export const SEAT_LABEL = "slp.role";

/** Seat named by the `slp.role` label; an unknown value counts as no label. */
export function seatOfLabels(labels: Record<string, string> | undefined): Seat | null {
  const label = labels?.[SEAT_LABEL];
  return label === "lead" || label === "peer" || label === "supervisor" ? label : null;
}

/** SLP seats run only on the base `claude` and `codex` providers; any other provider is not SLP. */
export function familyOf(provider: string): Family | null {
  return provider === "claude" || provider === "codex" ? provider : null;
}

/** Seat of an agent: its `slp.role` label, on a `claude` or `codex` provider only. */
export function seatOfAgent(agent: {
  provider: string;
  labels?: Record<string, string>;
}): Seat | null {
  return familyOf(agent.provider) ? seatOfLabels(agent.labels) : null;
}

/** Mode id each family runs the plugin-created Lead and Supervisor in without approval prompts. */
const UNATTENDED_MODE: Record<Family, string> = {
  claude: "bypassPermissions",
  codex: "full-access",
};

/** Provider and mode for a plugin-created seat agent; the seat itself travels as a label. */
export function seatProfileFor(family: Family): { providerId: string; modeId: string } {
  return { providerId: family, modeId: UNATTENDED_MODE[family] };
}

/** Codex Supervisor: writes stay inside its cwd, standing in for Claude's Write/Edit cut. */
export const CODEX_SUPERVISOR_OPTIONS = { sandbox_mode: "workspace-write" } as const;

/**
 * Codex Peer: `multi_agent` off stands in for Claude's Agent/Task cut; writes stay inside its cwd.
 */
export function withCodexPeerOptions(
  providerOptions: ProviderOptions,
): NonNullable<ProviderOptions> {
  const features = providerOptions?.features;
  return {
    ...providerOptions,
    sandbox_mode: "workspace-write",
    features: { ...(isRecord(features) ? features : {}), multi_agent: false },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Paseo MCP tools the Lead and Supervisor call without a permission card (Claude wildcard syntax). */
export const LEAD_ALLOWED_TOOLS = ["mcp__paseo__*"] as const;

/** Claude Peer spawns nothing with the provider's own subagent tools; it hands off to its Lead. */
export const PEER_DISALLOWED_TOOLS = ["Agent", "Task"] as const;

/** Supervisor writes no code and spawns nothing; Bash stays for Git reads and its own memory. */
export const SUPERVISOR_DISALLOWED_TOOLS = [
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Agent",
  "Task",
] as const;

/** Drops a leading YAML frontmatter block (`---` … `---`) and keeps the body. */
export function stripFrontmatter(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return match ? text.slice(match[0].length) : text;
}

export interface Definition {
  /** Absolute path of the override file, or `bundled` for the copy shipped with the plugin. */
  source: string;
  body: string;
}

/**
 * A repository can override a seat with `.slp/agents/<seat>.md` in the agent cwd; otherwise the
 * seat file bundled with the plugin applies. `.claude/agents/<seat>.md` is Claude Code's own
 * subagent definition directory, not read by this plugin.
 */
export async function readDefinition(cwd: string, seat: Seat): Promise<Definition> {
  const override = path.join(cwd, ".slp", "agents", `${seat}.md`);
  try {
    const text = await readFile(override, "utf8");
    return { source: override, body: stripFrontmatter(text).trim() };
  } catch {
    return { source: "bundled", body: stripFrontmatter(BUNDLED_DEFINITIONS[seat]).trim() };
  }
}

/** Seat system prompt = prompt already set by the caller + seat definition + SLP-RUNTIME block. */
export function buildSystemPrompt(
  seat: Seat,
  family: Family,
  definitionBody: string,
  existing: string | null | undefined,
): string {
  const parts = [
    existing?.trim(),
    `# Ghế SLP: ${seat}\n\n${definitionBody}`,
    runtimeBlock(seat, family),
  ];
  return parts.filter((part): part is string => Boolean(part)).join("\n\n");
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((t): t is string => typeof t === "string") : [];
}

export function withLeadAllowedTools(
  providerOptions: ProviderOptions,
): NonNullable<ProviderOptions> {
  const current = stringList(providerOptions?.allowedTools);
  return {
    ...providerOptions,
    allowedTools: [...new Set([...current, ...LEAD_ALLOWED_TOOLS])],
  };
}

function withDisallowedTools(
  providerOptions: ProviderOptions,
  tools: readonly string[],
): NonNullable<ProviderOptions> {
  const current = stringList(providerOptions?.disallowedTools);
  return { ...providerOptions, disallowedTools: [...new Set([...current, ...tools])] };
}

export function withSupervisorTools(
  providerOptions: ProviderOptions,
): NonNullable<ProviderOptions> {
  return withDisallowedTools(withLeadAllowedTools(providerOptions), SUPERVISOR_DISALLOWED_TOOLS);
}

/**
 * providerOptions per seat and family. Codex has no allowedTools (MCP tools show no card), so a
 * Codex Lead is unchanged.
 */
export function providerOptionsFor(
  seat: Seat,
  family: Family,
  providerOptions: ProviderOptions,
): ProviderOptions {
  if (family === "codex") {
    switch (seat) {
      case "supervisor":
        return { ...providerOptions, ...CODEX_SUPERVISOR_OPTIONS };
      case "peer":
        return withCodexPeerOptions(providerOptions);
      default:
        return providerOptions;
    }
  }
  switch (seat) {
    case "lead":
      return withLeadAllowedTools(providerOptions);
    case "supervisor":
      return withSupervisorTools(providerOptions);
    case "peer":
      return withDisallowedTools(providerOptions, PEER_DISALLOWED_TOOLS);
  }
}

/** Paseo tools a Peer loses: it cannot spawn, steer, or stop other agents. */
export const PEER_DISABLED_PASEO_TOOLS = [
  "create_agent",
  "send_agent_prompt",
  "kill_agent",
  "cancel_agent",
  "archive_agent",
  "create_schedule",
] as const;

/** The Supervisor is read-only: every mutating Paseo tool is off; reads and send_agent_prompt stay. */
export const SUPERVISOR_DISABLED_PASEO_TOOLS = [
  "create_workspace",
  "archive_workspace",
  "rename_workspace",
  "create_agent",
  "update_agent",
  "cancel_agent",
  "archive_agent",
  "kill_agent",
  "set_agent_mode",
  "respond_to_permission",
  "start_workspace_script",
  "stop_workspace_script",
  "create_terminal",
  "kill_terminal",
  "send_terminal_keys",
  "create_schedule",
  "update_schedule",
  "pause_schedule",
  "resume_schedule",
  "delete_schedule",
  "run_schedule_once",
  "create_heartbeat",
  "delete_heartbeat",
  "browser_new_tab",
  "browser_close_tab",
  "browser_navigate",
  "browser_click",
  "browser_fill",
  "browser_type",
  "browser_keypress",
  "browser_select",
  "browser_drag",
  "browser_upload",
  "browser_scroll",
  "browser_resize",
  "browser_evaluate",
] as const;

export type PaseoToolsPolicy = PluginBeforeRequests["agent.create"]["paseoTools"];

/**
 * Per-agent Paseo tool cut for a seat, added to whatever the request already disabled. The daemon
 * merges it with the provider policy and freezes it into the agent record. A Lead keeps every tool.
 */
export function paseoToolsFor(seat: Seat, current: PaseoToolsPolicy): PaseoToolsPolicy {
  if (seat === "lead") return current;
  const cut = seat === "peer" ? PEER_DISABLED_PASEO_TOOLS : SUPERVISOR_DISABLED_PASEO_TOOLS;
  return {
    ...current,
    disabledTools: [...new Set([...(current?.disabledTools ?? []), ...cut])],
  };
}
