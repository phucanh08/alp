import type { PluginBeforeRequests } from "@alp/plugin/server";
import path from "node:path";
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

/**
 * Label the daemon sets from the real caller of `create_agent` (`PARENT_AGENT_ID_LABEL` in
 * `packages/protocol/src/agent-labels.ts`); a hook can read it but never set or clear it. Kept as
 * a local literal, like the Alp tool lists this plugin copies elsewhere, so the plugin takes no
 * runtime dependency on that package.
 */
const PARENT_AGENT_ID_LABEL = "alp.parent-agent-id";

/** Label marking a seat this plugin assigned by default rather than one the requester chose. */
export const ORIGIN_LABEL = "slp.origin";

/**
 * True unless another agent made this request: the daemon sets `alp.parent-agent-id` only when
 * `create_agent` names a real calling agent, so its absence means the request came directly from a
 * Human (the app or the CLI) or from a schedule run, neither of which is "another agent" for this
 * check.
 */
export function isHumanCreated(labels: Record<string, string> | undefined): boolean {
  return labels?.[PARENT_AGENT_ID_LABEL] === undefined;
}

/**
 * Label a schedule run sets on the agent it creates directly, naming the schedule
 * (`packages/server/src/server/schedule/service.ts`). Presence of this label is how a defaulted
 * seat is tagged `slp.origin=schedule` instead of `slp.origin=human`.
 */
const SCHEDULE_ID_LABEL = "alp.schedule-id";

/** The two values `slp.origin` can hold on a seat this plugin defaulted rather than the requester chose. */
export type SeatOrigin = "human" | "schedule";

function originOf(labels: Record<string, string> | undefined): SeatOrigin {
  return labels?.[SCHEDULE_ID_LABEL] !== undefined ? "schedule" : "human";
}

/**
 * `slp.origin` off a label set, valid values only: a Peer a Lead spawned never carries this label
 * (`lead()` in `runtime-block.ts` spawns with `{"slp.role": "peer"}` alone), so its presence is how
 * `buildSystemPrompt` tells an independent Peer — one with no Lead to report to — from an ordinary
 * one.
 */
export function originOfLabels(labels: Record<string, string> | undefined): SeatOrigin | null {
  const value = labels?.[ORIGIN_LABEL];
  return value === "human" || value === "schedule" ? value : null;
}

/**
 * Seat labels for an `agent.create` request that named no seat at all: a request with no
 * `alp.parent-agent-id` — Human made it directly, or a schedule run created it — defaults to
 * Peer, tagged `slp.origin=schedule` when the request carries `alp.schedule-id` and
 * `slp.origin=human` otherwise, so it reads apart from a Peer a Lead spawned. Null once the
 * request already opines on a seat — even an invalid `slp.role` value counts as an opinion and is
 * left alone — or was made by another agent.
 */
export function defaultSeatLabels(
  labels: Record<string, string> | undefined,
): Record<string, string> | null {
  if (labels !== undefined && SEAT_LABEL in labels) return null;
  if (!isHumanCreated(labels)) return null;
  return { ...labels, [SEAT_LABEL]: "peer", [ORIGIN_LABEL]: originOf(labels) };
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

/** Alp MCP tools the Lead and Supervisor call without a permission card (Claude wildcard syntax). */
export const LEAD_ALLOWED_TOOLS = ["mcp__alp__*"] as const;

/** Claude Peer spawns nothing with the provider's own subagent tools; it hands off to its Lead. */
export const PEER_DISALLOWED_TOOLS = ["Agent", "Task"] as const;

/**
 * Supervisor writes no code, spawns nothing, and runs no skill (it has no seat skill directory);
 * Bash stays for Git reads and its own memory.
 */
export const SUPERVISOR_DISALLOWED_TOOLS = [
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Agent",
  "Task",
  "Skill",
] as const;

/** Drops a leading YAML frontmatter block (`---` … `---`) and keeps the body. */
export function stripFrontmatter(text: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
  return match ? text.slice(match[0].length) : text;
}

/**
 * Seat system prompt = prompt already set by the caller + seat definition + SLP-RUNTIME block.
 * A null `definitionBody` (no override and slp-dev did not answer) leaves the runtime block alone,
 * which then says the seat rules did not load.
 * `origin` only ever applies to a Peer with no Lead (see `originOfLabels`); it adds the
 * independent-Peer paragraph to the runtime block. `skills` are the seat's own, named in the block.
 * `seatSkillsDirectory` is the seat's real skill directory (`seat-skills.ts`), forwarded to the block
 * for a Codex seat that has one — see `runtimeBlock`.
 */
export function buildSystemPrompt(
  seat: Seat,
  family: Family,
  definitionBody: string | null,
  existing: string | null | undefined,
  origin?: SeatOrigin | null,
  skills: readonly string[] = [],
  seatSkillsDirectory: string | null = null,
): string {
  const parts = [
    existing?.trim(),
    definitionBody === null ? null : `# Ghế SLP: ${seat}\n\n${definitionBody}`,
    runtimeBlock(seat, family, origin, skills, definitionBody !== null, seatSkillsDirectory),
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
 * Adds the seat skill directory (`seat-skills.ts`): Claude loads it as a local plugin, Codex reads
 * its `skills/` as an extra skill root. Either is appended to what the request already set; no
 * Claude `skills` allow-list, so the Human's own skills stay visible next to the seat's.
 */
function withSeatSkills(
  family: Family,
  providerOptions: ProviderOptions,
  seatSkillsDirectory: string | null,
): ProviderOptions {
  if (!seatSkillsDirectory) return providerOptions;
  if (family === "claude") {
    const current = Array.isArray(providerOptions?.plugins) ? providerOptions.plugins : [];
    const plugin = { type: "local", path: seatSkillsDirectory };
    return {
      ...providerOptions,
      plugins: [
        ...current.filter((entry) => !isRecord(entry) || entry.path !== plugin.path),
        plugin,
      ],
    };
  }
  const skills = isRecord(providerOptions?.skills) ? providerOptions.skills : {};
  const root = path.join(seatSkillsDirectory, "skills");
  return {
    ...providerOptions,
    skills: {
      ...skills,
      extraRoots: [...new Set([...stringList(skills.extraRoots), root])],
    },
  };
}

/**
 * providerOptions per seat and family. Codex has no allowedTools (MCP tools show no card), so a
 * Codex Lead gets only its skills. `seatSkillsDirectory` applies to Lead and Peer; the Supervisor
 * branches ignore it.
 */
export function providerOptionsFor(
  seat: Seat,
  family: Family,
  providerOptions: ProviderOptions,
  seatSkillsDirectory: string | null = null,
): ProviderOptions {
  if (family === "codex") {
    switch (seat) {
      case "supervisor":
        return { ...providerOptions, ...CODEX_SUPERVISOR_OPTIONS };
      case "peer":
        return withSeatSkills(family, withCodexPeerOptions(providerOptions), seatSkillsDirectory);
      default:
        return withSeatSkills(family, providerOptions, seatSkillsDirectory);
    }
  }
  switch (seat) {
    case "lead":
      return withSeatSkills(family, withLeadAllowedTools(providerOptions), seatSkillsDirectory);
    case "supervisor":
      return withSupervisorTools(providerOptions);
    case "peer":
      return withSeatSkills(
        family,
        withDisallowedTools(providerOptions, PEER_DISALLOWED_TOOLS),
        seatSkillsDirectory,
      );
  }
}

/**
 * Alp tools a Peer loses: it cannot spawn, steer, or stop other agents, reconfigure any agent's
 * provider or mode, or resolve a permission prompt on another agent's behalf.
 */
export const PEER_DISABLED_ALP_TOOLS = [
  "create_agent",
  "send_agent_prompt",
  "kill_agent",
  "cancel_agent",
  "archive_agent",
  "create_schedule",
  "update_agent",
  "set_agent_mode",
  "respond_to_permission",
] as const;

/** The Supervisor is read-only: every mutating Alp tool is off; reads and send_agent_prompt stay. */
export const SUPERVISOR_DISABLED_ALP_TOOLS = [
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

export type AlpToolsPolicy = PluginBeforeRequests["agent.create"]["alpTools"];

/**
 * Per-agent Alp tool cut for a seat, added to whatever the request already disabled. The daemon
 * merges it with the provider policy and freezes it into the agent record. A Lead keeps every tool.
 */
export function alpToolsFor(seat: Seat, current: AlpToolsPolicy): AlpToolsPolicy {
  if (seat === "lead") return current;
  const cut = seat === "peer" ? PEER_DISABLED_ALP_TOOLS : SUPERVISOR_DISABLED_ALP_TOOLS;
  return {
    ...current,
    disabledTools: [...new Set([...(current?.disabledTools ?? []), ...cut])],
  };
}
