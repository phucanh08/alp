import { expect, test } from "vitest";
import {
  type AgentEntryLike,
  counterpartSeat,
  formatRoster,
  leadAnnouncement,
  listLiveAgents,
  selectClosedSeatAgents,
  selectSeatAgents,
  supervisorsRegisteredIn,
} from "./discovery";

const entries: AgentEntryLike[] = [
  {
    agent: {
      id: "L1",
      provider: "claude-lead",
      cwd: "/r/a",
      status: "idle",
      title: "lead-a",
      workspaceId: "w1",
    },
  },
  {
    agent: {
      id: "L2",
      provider: "claude-lead",
      cwd: "/r/b",
      status: "running",
      archivedAt: "2026-09-24",
    },
  },
  { agent: { id: "L3", provider: "claude-lead", cwd: "/r/c", status: "closed" } },
  {
    agent: {
      id: "L4",
      provider: "claude",
      cwd: "/r/d",
      status: "idle",
      labels: { "slp.role": "lead" },
    },
  },
  { agent: { id: "S1", provider: "claude-supervisor", cwd: "/sup", status: "idle", title: "sup" } },
  { agent: { id: "P1", provider: "claude-peer", cwd: "/r/a/wt", status: "running" } },
  { agent: { id: "X1", provider: "claude", cwd: "/x", status: "idle" } },
];

test("selectSeatAgents keeps the seat by label or provider and drops archived, closed, and self", () => {
  expect(selectSeatAgents(entries, "lead").map((a) => a.id)).toEqual(["L1", "L4"]);
  expect(selectSeatAgents(entries, "supervisor").map((a) => a.id)).toEqual(["S1"]);
  expect(selectSeatAgents(entries, "lead", "L1").map((a) => a.id)).toEqual(["L4"]);
  expect(selectSeatAgents(entries, "lead")[0]?.workspaceId).toBe("w1");
});

test("selectClosedSeatAgents keeps closed, unarchived agents of the seat, newest activity first", () => {
  const closed: AgentEntryLike[] = [
    ...entries,
    {
      agent: {
        id: "S-old",
        provider: "claude",
        cwd: "/sup",
        status: "closed",
        labels: { "slp.role": "supervisor" },
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-10T00:00:00.000Z",
      },
    },
    {
      agent: {
        id: "S-new",
        provider: "claude-supervisor",
        cwd: "/sup",
        status: "closed",
        workspaceId: "w-sup",
        createdAt: "2026-09-02T00:00:00.000Z",
        updatedAt: "2026-09-24T00:00:00.000Z",
      },
    },
    {
      agent: {
        id: "S-archived",
        provider: "claude-supervisor",
        cwd: "/sup",
        status: "closed",
        updatedAt: "2026-09-25T00:00:00.000Z",
        archivedAt: "2026-09-25",
      },
    },
    { agent: { id: "S-undated", provider: "claude-supervisor", cwd: "/sup", status: "closed" } },
  ];
  expect(selectClosedSeatAgents(closed, "supervisor").map((a) => a.id)).toEqual([
    "S-new",
    "S-old",
    "S-undated",
  ]);
  expect(selectClosedSeatAgents(closed, "supervisor")[0]?.workspaceId).toBe("w-sup");
  expect(selectClosedSeatAgents(closed, "lead").map((a) => a.id)).toEqual(["L3"]);
});

test("listLiveAgents follows every page cursor", async () => {
  const calls: Array<string | undefined> = [];
  const pages: Record<string, { entries: AgentEntryLike[]; next: string | null }> = {
    first: { entries: entries.slice(0, 2), next: "c2" },
    c2: { entries: entries.slice(2), next: null },
  };
  const all = await listLiveAgents({
    async list(options) {
      calls.push(options.page.cursor);
      const page = pages[options.page.cursor ?? "first"];
      return { entries: page.entries, pageInfo: { nextCursor: page.next } };
    },
  });
  expect(calls).toEqual([undefined, "c2"]);
  expect(all).toHaveLength(entries.length);
});

test("counterpartSeat pairs lead and supervisor; a peer has none", () => {
  expect(counterpartSeat("lead")).toBe("supervisor");
  expect(counterpartSeat("supervisor")).toBe("lead");
  expect(counterpartSeat("peer")).toBeNull();
});

test("formatRoster is empty without agents and lists id, cwd, status otherwise", () => {
  expect(formatRoster("lead", [])).toBe("");
  const text = formatRoster("supervisor", selectSeatAgents(entries, "supervisor"));
  expect(text).toMatch(/^## Supervisor hiện có/);
  expect(text).toMatch(/`S1`.*`\/sup`.*status idle/);
  expect(text).toMatch(/get_agent_status/);
});

test("supervisorsRegisteredIn counts only successful send_agent_prompt calls to a known id", () => {
  const call = (name: string, input: unknown, error: unknown = null) => ({
    type: "tool_call",
    callId: "x",
    name,
    detail: { type: "unknown", input, output: { hint: "use send_agent_prompt", agentId: "S2" } },
    status: "completed",
    error,
  });
  const timeline = [
    call("ToolSearch", { query: "select:mcp__paseo__send_agent_prompt" }),
    call("mcp__paseo__get_agent_status", { agentId: "S1" }),
    { type: "assistant_message", text: 'Sẽ send_agent_prompt {"agentId":"S2"} sau.' },
    call("mcp__paseo__send_agent_prompt", { agentId: "S1", prompt: "SLP-REGISTER …" }),
    call("mcp__paseo__send_agent_prompt", { agentId: "S3" }, { message: "not found" }),
  ];
  expect([...supervisorsRegisteredIn(timeline, ["S1", "S2", "S3"])]).toEqual(["S1"]);
  expect(supervisorsRegisteredIn(undefined, ["S1"]).size).toBe(0);
});

test("leadAnnouncement names the Lead, its root, and says it is not from the Human", () => {
  const text = leadAnnouncement({
    id: "L9",
    seat: "lead",
    title: "lead-x",
    cwd: "/r/x",
    status: "idle",
    workspaceId: null,
  });
  expect(text).toMatch(/\[plugin slp\] Lead mới/);
  expect(text).toMatch(/`L9`.*Root `\/r\/x`/);
  expect(text).toMatch(/không phải Human/);
});
