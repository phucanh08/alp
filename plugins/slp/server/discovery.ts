import { type Seat, seatOfAgent } from "./seat";

/** An agent on this host, trimmed for the roster in a system prompt. */
export interface SeatAgent {
  id: string;
  seat: Seat;
  title: string | null;
  cwd: string;
  status: string;
  workspaceId: string | null;
}

/** Minimal shape of an `agents.list()` entry; kept narrow so tests need no SDK. */
export interface AgentEntryLike {
  agent: {
    id: string;
    provider: string;
    cwd: string;
    status: string;
    workspaceId?: string;
    title?: string | null;
    labels?: Record<string, string>;
    archivedAt?: string | null;
    createdAt?: string;
    updatedAt?: string;
  };
}

export interface AgentListPage {
  entries: AgentEntryLike[];
  pageInfo: { nextCursor: string | null };
}

export interface AgentLister {
  list(options: {
    filter: { includeArchived: false };
    page: { limit: number; cursor?: string };
  }): Promise<AgentListPage>;
}

function toSeatAgent(agent: AgentEntryLike["agent"], seat: Seat): SeatAgent {
  return {
    id: agent.id,
    seat,
    title: agent.title ?? null,
    cwd: agent.cwd,
    status: agent.status,
    workspaceId: agent.workspaceId ?? null,
  };
}

/** Live agents in a seat: SLP label or provider, not archived, not closed; skips `excludeId`. */
export function selectSeatAgents(
  entries: readonly AgentEntryLike[],
  seat: Seat,
  excludeId?: string,
): SeatAgent[] {
  const out: SeatAgent[] = [];
  for (const { agent } of entries) {
    if (agent.id === excludeId || agent.archivedAt || agent.status === "closed") continue;
    if (seatOfAgent(agent) !== seat) continue;
    out.push(toSeatAgent(agent, seat));
  }
  return out;
}

function lastActivity(agent: AgentEntryLike["agent"]): number {
  const time = Date.parse(agent.updatedAt ?? agent.createdAt ?? "");
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

/**
 * Closed agents in a seat, newest activity first. `closed` is resumable: the record keeps its
 * provider session, timeline, and labels; a daemon restart leaves every agent in this state.
 */
export function selectClosedSeatAgents(
  entries: readonly AgentEntryLike[],
  seat: Seat,
): SeatAgent[] {
  return entries
    .filter(({ agent }) => !agent.archivedAt && agent.status === "closed")
    .filter(({ agent }) => seatOfAgent(agent) === seat)
    .sort((a, b) => lastActivity(b.agent) - lastActivity(a.agent))
    .map(({ agent }) => toSeatAgent(agent, seat));
}

/** Every page of unarchived agents; the daemon caps a page at 200. */
export async function listLiveAgents(agents: AgentLister): Promise<AgentEntryLike[]> {
  const all: AgentEntryLike[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await agents.list({
      filter: { includeArchived: false },
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    all.push(...page.entries);
    if (!page.pageInfo.nextCursor) return all;
    cursor = page.pageInfo.nextCursor;
  }
}

export async function findSeatAgents(
  agents: AgentLister,
  seat: Seat,
  excludeId?: string,
): Promise<SeatAgent[]> {
  return selectSeatAgents(await listLiveAgents(agents), seat, excludeId);
}

/** Lead and Supervisor need to know each other. A Peer has no roster. */
export function counterpartSeat(seat: Seat): Seat | null {
  if (seat === "lead") return "supervisor";
  if (seat === "supervisor") return "lead";
  return null;
}

/** Roster block appended to the system prompt; empty when nobody is there. */
export function formatRoster(seat: Seat, agents: readonly SeatAgent[]): string {
  if (agents.length === 0) return "";
  const title = seat === "supervisor" ? "Supervisor hiện có" : "Lead hiện có";
  const rows = agents.map(
    (a) =>
      `- id \`${a.id}\` · title \`${a.title ?? "-"}\` · cwd \`${a.cwd}\` · status ${a.status} (lúc bạn được tạo)`,
  );
  return `## ${title} (plugin slp liệt kê lúc tạo bạn)\n${rows.join("\n")}\nTrạng thái ở trên là ảnh chụp; kiểm lại bằng \`get_agent_status\` trước khi nhắn.`;
}

/**
 * Supervisors the Lead already reached with `send_agent_prompt`, read from the `agent.turn_ended`
 * timeline. Only `tool_call` items named `…send_agent_prompt` with `detail.input.agentId` set to a
 * Supervisor and no error count. No substring search: `get_agent_status`/`ToolSearch` output also
 * contains the text `send_agent_prompt` (false positive measured 2026-09-24).
 */
export function supervisorsRegisteredIn(
  timeline: unknown,
  supervisorIds: readonly string[],
): Set<string> {
  const found = new Set<string>();
  if (!Array.isArray(timeline)) return found;
  for (const item of timeline) {
    if (!item || typeof item !== "object") continue;
    const { type, name, detail, error } = item as {
      type?: unknown;
      name?: unknown;
      detail?: unknown;
      error?: unknown;
    };
    if (type !== "tool_call" || typeof name !== "string" || !name.endsWith("send_agent_prompt")) {
      continue;
    }
    if (error) continue;
    const target = (detail as { input?: { agentId?: unknown } } | undefined)?.input?.agentId;
    if (typeof target === "string" && supervisorIds.includes(target)) found.add(target);
  }
  return found;
}

/** Message to a Supervisor when a new Lead finished its first turn without registering. */
export function leadAnnouncement(lead: SeatAgent): string {
  return `[plugin slp] Lead mới trên host: id \`${lead.id}\` · title \`${lead.title ?? "-"}\` · Root \`${lead.cwd}\`. Lead vừa kết thúc lượt đầu mà chưa gửi SLP-REGISTER (lúc đó bạn đang chạy) — nó không tự thử lại; kiểm \`get_agent_status\`, idle thì mở phiên ngay bằng \`send_agent_prompt\`. Tin này từ plugin, không phải Human.`;
}
