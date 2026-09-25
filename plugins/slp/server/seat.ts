import type { PluginBeforeRequests } from "@getpaseo/plugin/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { BUNDLED_DEFINITIONS } from "./definitions.gen";
import { runtimeBlock } from "./runtime-block";

export type Seat = "lead" | "peer" | "supervisor";

/** providerOptions of an agent config, taken from the hook type so the plugin needs no extra deps. */
export type ProviderOptions = PluginBeforeRequests["agent.create"]["config"]["providerOptions"];

/** Base provider family of a profile: decides which providerOptions mean anything. */
export type Family = "claude" | "codex";

/** Agent label that names the seat. */
export const SEAT_LABEL = "slp.role";

/** Provider profile (`<family>-<seat>`, extends claude|codex in the daemon config) → SLP seat. */
const SEAT_BY_PROVIDER: Record<string, Seat> = {
  "claude-lead": "lead",
  "claude-peer": "peer",
  "claude-supervisor": "supervisor",
  "codex-lead": "lead",
  "codex-peer": "peer",
  "codex-supervisor": "supervisor",
};

export function seatOf(provider: string): Seat | null {
  return SEAT_BY_PROVIDER[provider] ?? null;
}

export function familyOf(provider: string): Family | null {
  if (!(provider in SEAT_BY_PROVIDER)) return null;
  return provider.startsWith("codex-") ? "codex" : "claude";
}

/** Seat from the `slp.role` label, falling back to the provider profile. */
export function seatOfAgent(agent: {
  provider: string;
  labels?: Record<string, string>;
}): Seat | null {
  const label = agent.labels?.[SEAT_LABEL];
  if (label === "lead" || label === "peer" || label === "supervisor") return label;
  return seatOf(agent.provider);
}

/** Codex Supervisor: writes stay inside its cwd, standing in for Claude's Write/Edit cut. */
export const CODEX_SUPERVISOR_OPTIONS = { sandbox_mode: "workspace-write" } as const;

/** Paseo MCP tools the Lead and Supervisor call without a permission card (Claude wildcard syntax). */
export const LEAD_ALLOWED_TOOLS = ["mcp__paseo__*"] as const;

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
 * A repository can override a seat with `.claude/agents/<seat>.md` in the agent cwd; otherwise the
 * seat file bundled with the plugin applies.
 */
export async function readDefinition(cwd: string, seat: Seat): Promise<Definition> {
  const override = path.join(cwd, ".claude", "agents", `${seat}.md`);
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
  definitionBody: string,
  existing: string | null | undefined,
): string {
  const parts = [existing?.trim(), `# Ghế SLP: ${seat}\n\n${definitionBody}`, runtimeBlock(seat)];
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

export function withSupervisorTools(
  providerOptions: ProviderOptions,
): NonNullable<ProviderOptions> {
  const current = stringList(providerOptions?.disallowedTools);
  return {
    ...withLeadAllowedTools(providerOptions),
    disallowedTools: [...new Set([...current, ...SUPERVISOR_DISALLOWED_TOOLS])],
  };
}

/**
 * providerOptions per seat and family. Peer is unchanged: its boundary lives in the provider profile.
 * Codex has no allowedTools (MCP tools show no card), so a Codex Lead is unchanged.
 */
export function providerOptionsFor(
  seat: Seat,
  family: Family,
  providerOptions: ProviderOptions,
): ProviderOptions {
  if (family === "codex") {
    return seat === "supervisor"
      ? { ...providerOptions, ...CODEX_SUPERVISOR_OPTIONS }
      : providerOptions;
  }
  switch (seat) {
    case "lead":
      return withLeadAllowedTools(providerOptions);
    case "supervisor":
      return withSupervisorTools(providerOptions);
    default:
      return providerOptions;
  }
}
