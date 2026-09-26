import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import type { AgentLister } from "./discovery";
import { allowPaseoTools, createLeadAnnouncer, withSeatConfig } from "./hooks";

const agents: AgentLister = {
  async list() {
    return {
      entries: [
        {
          agent: {
            id: "S1",
            provider: "claude",
            cwd: "/sup",
            status: "idle",
            title: "Supervisor",
            labels: { "slp.role": "supervisor" },
          },
        },
        {
          agent: {
            id: "L1",
            provider: "codex",
            cwd: "/r/a",
            status: "idle",
            title: "Lead",
            labels: { "slp.role": "lead" },
          },
        },
      ],
      pageInfo: { nextCursor: null },
    };
  },
};

async function request(provider: string, labels?: Record<string, string>) {
  const cwd = await mkdtemp(path.join(tmpdir(), "slp-hooks-"));
  return {
    config: {
      provider,
      cwd,
      systemPrompt: "EXISTING",
      providerOptions: { allowedTools: ["Bash"] },
    },
    ...(labels ? { labels } : {}),
  };
}

// Literal copies of the daemon lists in packages/server/src/server/persisted-config.ts at 9356833d3
// (SLP_PEER_DISABLED_TOOLS, SLP_SUPERVISOR_DISABLED_TOOLS). Not imported: a Peer or Supervisor must
// not gain a tool, and the test is the oracle for that.
const PEER_PASEO_CUT = [
  "create_agent",
  "send_agent_prompt",
  "kill_agent",
  "cancel_agent",
  "archive_agent",
  "create_schedule",
];

const SUPERVISOR_PASEO_CUT = [
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
];

interface SeatResult {
  config: { systemPrompt: string; providerOptions?: Record<string, unknown> };
  labels?: Record<string, string>;
  paseoTools?: { enabled?: boolean; disabledTools?: string[] };
}

async function seatConfig(provider: string, labels?: Record<string, string>) {
  return (await withSeatConfig((await request(provider, labels)) as never, agents)) as
    | SeatResult
    | undefined;
}

test("a Claude Peer by label loses the Peer Paseo tools and Agent/Task", async () => {
  const result = await seatConfig("claude", { "slp.role": "peer" });
  expect(result?.paseoTools).toEqual({ disabledTools: PEER_PASEO_CUT });
  expect(result?.config.providerOptions).toEqual({
    allowedTools: ["Bash"],
    disallowedTools: ["Agent", "Task"],
  });
  expect(result?.config.systemPrompt).toContain("# Ghế SLP: peer");
  expect(result?.labels).toEqual({ "slp.role": "peer" });
});

test("a Codex Peer by label loses the Peer Paseo tools, multi_agent, and writes outside its cwd", async () => {
  const result = await seatConfig("codex", { "slp.role": "peer" });
  expect(result?.paseoTools).toEqual({ disabledTools: PEER_PASEO_CUT });
  expect(result?.config.providerOptions).toEqual({
    allowedTools: ["Bash"],
    sandbox_mode: "workspace-write",
    features: { multi_agent: false },
  });
});

test("a Supervisor by label loses the Supervisor Paseo tools on Claude and Codex", async () => {
  const claude = await seatConfig("claude", { "slp.role": "supervisor" });
  expect(claude?.paseoTools).toEqual({ disabledTools: SUPERVISOR_PASEO_CUT });
  expect(claude?.config.providerOptions).toEqual({
    allowedTools: ["Bash", "mcp__paseo__*"],
    disallowedTools: ["Write", "Edit", "MultiEdit", "NotebookEdit", "Agent", "Task"],
  });
  expect(claude?.config.systemPrompt).toMatch(/## Lead hiện có[\s\S]*`L1`/);

  const codex = await seatConfig("codex", { "slp.role": "supervisor" });
  expect(codex?.paseoTools).toEqual({ disabledTools: SUPERVISOR_PASEO_CUT });
  expect(codex?.config.providerOptions).toEqual({
    allowedTools: ["Bash"],
    sandbox_mode: "workspace-write",
  });
});

test("a Peer cut adds to Paseo tools the request already disabled", async () => {
  const base = await request("claude", { "slp.role": "peer" });
  const result = (await withSeatConfig(
    { ...base, paseoTools: { disabledTools: ["browser_click", "kill_agent"] } } as never,
    agents,
  )) as SeatResult | undefined;
  expect(result?.paseoTools).toEqual({
    disabledTools: [
      "browser_click",
      "kill_agent",
      ...PEER_PASEO_CUT.filter((t) => t !== "kill_agent"),
    ],
  });
});

test("a Claude Lead by label keeps every Paseo tool and gets the Paseo wildcard", async () => {
  const result = await seatConfig("claude", { "slp.role": "lead" });
  expect(result).toBeDefined();
  expect(result).not.toHaveProperty("paseoTools");
  expect(result?.config.providerOptions).toEqual({ allowedTools: ["Bash", "mcp__paseo__*"] });
  expect(result?.config.systemPrompt).toMatch(/## Supervisor hiện có[\s\S]*`S1`/);
});

test("a seat label on a provider other than claude or codex leaves the request alone", async () => {
  expect(await seatConfig("acp", { "slp.role": "peer" })).toBeUndefined();
  expect(await seatConfig("opencode", { "slp.role": "supervisor" })).toBeUndefined();
});

test("claude or codex with an unknown slp.role value is left alone, not defaulted", async () => {
  expect(await seatConfig("claude", { "slp.role": "reviewer" })).toBeUndefined();
});

test("a Human-made Claude agent with no seat label defaults to Peer, tagged slp.origin=human", async () => {
  const result = await seatConfig("claude");
  expect(result?.labels).toEqual({ "slp.role": "peer", "slp.origin": "human" });
  expect(result?.paseoTools).toEqual({ disabledTools: PEER_PASEO_CUT });
  expect(result?.config.providerOptions).toEqual({
    allowedTools: ["Bash"],
    disallowedTools: ["Agent", "Task"],
  });
  expect(result?.config.systemPrompt).toContain("# Ghế SLP: peer");
});

test("a Human-made Codex agent with no seat label defaults to Peer, tagged slp.origin=human", async () => {
  const result = await seatConfig("codex", {});
  expect(result?.labels).toEqual({ "slp.role": "peer", "slp.origin": "human" });
  expect(result?.paseoTools).toEqual({ disabledTools: PEER_PASEO_CUT });
  expect(result?.config.providerOptions).toEqual({
    allowedTools: ["Bash"],
    sandbox_mode: "workspace-write",
    features: { multi_agent: false },
  });
});

test("an agent another agent created (paseo.parent-agent-id set) with no seat label is left alone", async () => {
  expect(await seatConfig("claude", { "paseo.parent-agent-id": "L1" })).toBeUndefined();
});

test("a request that already names a valid seat is never tagged slp.origin", async () => {
  const result = await seatConfig("claude", { "slp.role": "lead" });
  expect(result?.labels).toEqual({ "slp.role": "lead" });
});

test("a Human-made agent keeps its other labels alongside the default seat and origin", async () => {
  const result = await seatConfig("claude", { foo: "bar" });
  expect(result?.labels).toEqual({ foo: "bar", "slp.role": "peer", "slp.origin": "human" });
});

test("the retired <family>-<seat> provider names no longer pick a seat", async () => {
  expect(await seatConfig("claude-peer")).toBeUndefined();
  expect(await seatConfig("codex-supervisor")).toBeUndefined();
  expect(await seatConfig("claude-lead")).toBeUndefined();
  expect(await seatConfig("claude-peer", { "slp.role": "peer" })).toBeUndefined();
});

test("agent.create for a Lead injects the bundled seat rules, runtime block, Supervisor roster, and Paseo tools", async () => {
  const result = await withSeatConfig(
    (await request("claude", { "slp.role": "lead" })) as never,
    agents,
  );
  const config = result?.config as {
    systemPrompt: string;
    providerOptions: Record<string, unknown>;
  };
  expect(config.systemPrompt.startsWith("EXISTING\n\n# Ghế SLP: lead\n\n")).toBe(true);
  expect(config.systemPrompt).not.toMatch(/^name: lead$/m);
  expect(config.systemPrompt).not.toMatch(/^tools: Agent\(peer\)/m);
  expect(config.systemPrompt).toContain("Model: <model> · Effort: <effort> — <lý do>");
  expect(config.systemPrompt).toMatch(/## Supervisor hiện có[\s\S]*`S1`/);
  expect(config.systemPrompt).not.toContain("`L1`");
  expect(config.providerOptions).toEqual({ allowedTools: ["Bash", "mcp__paseo__*"] });
});

test("agent.create for a Supervisor lists Leads and cuts write and spawn tools", async () => {
  const result = await withSeatConfig(
    (await request("claude", { "slp.role": "supervisor" })) as never,
    agents,
  );
  const config = result?.config as {
    systemPrompt: string;
    providerOptions: Record<string, unknown>;
  };
  expect(config.systemPrompt).toMatch(/## Lead hiện có[\s\S]*`L1`/);
  expect(config.providerOptions.disallowedTools).toEqual([
    "Write",
    "Edit",
    "MultiEdit",
    "NotebookEdit",
    "Agent",
    "Task",
  ]);
});

test("agent.create leaves non-SLP providers untouched", async () => {
  expect(await withSeatConfig((await request("acp")) as never, agents)).toBeUndefined();
});

interface HookCalls {
  sent: Array<{ agentId: string; text: string }>;
  permissions: Array<{ agentId: string; requestId: string }>;
}

function hookContext(entries: Awaited<ReturnType<AgentLister["list"]>>["entries"]) {
  const calls: HookCalls = { sent: [], permissions: [] };
  const context = {
    paseo: {
      agents: {
        async list() {
          return { entries, pageInfo: { nextCursor: null } };
        },
        ref(agentId: string) {
          return {
            async send(text: string) {
              calls.sent.push({ agentId, text });
            },
            async respondToPermission(options: { requestId: string }) {
              calls.permissions.push({ agentId, requestId: options.requestId });
            },
          };
        },
      },
    },
  };
  return { calls, context: context as never };
}

function hookAgent(id: string, provider: string, labels?: Record<string, string>) {
  return {
    id,
    workspaceId: "w1",
    parentAgentId: null,
    provider,
    cwd: "/r/a",
    title: id,
    ...(labels ? { labels } : {}),
  };
}

function paseoPermission(agent: ReturnType<typeof hookAgent>) {
  return {
    agent,
    request: { id: `req-${agent.id}`, kind: "tool", name: "mcp__paseo__list_agents" },
  } as never;
}

test("allowPaseoTools allows Paseo tools for a Lead or Supervisor by label, not for a Peer", async () => {
  const { calls, context } = hookContext([]);
  await allowPaseoTools(paseoPermission(hookAgent("L", "claude", { "slp.role": "lead" })), context);
  await allowPaseoTools(
    paseoPermission(hookAgent("S", "codex", { "slp.role": "supervisor" })),
    context,
  );
  await allowPaseoTools(paseoPermission(hookAgent("P", "claude", { "slp.role": "peer" })), context);
  await allowPaseoTools(paseoPermission(hookAgent("X", "claude")), context);
  await allowPaseoTools(paseoPermission(hookAgent("OLD", "claude-lead")), context);
  await allowPaseoTools(paseoPermission(hookAgent("ACP", "acp", { "slp.role": "lead" })), context);
  expect(calls.permissions).toEqual([
    { agentId: "L", requestId: "req-L" },
    { agentId: "S", requestId: "req-S" },
  ]);
});

test("the Lead announcer tells an idle Supervisor about a new Lead, both found by label", async () => {
  const { calls, context } = hookContext([
    {
      agent: {
        id: "S1",
        provider: "claude",
        cwd: "/sup",
        status: "idle",
        title: "Supervisor",
        labels: { "slp.role": "supervisor" },
      },
    },
    { agent: { id: "S-old", provider: "claude-supervisor", cwd: "/sup", status: "idle" } },
  ]);
  const announce = createLeadAnnouncer();
  const turnEnded = (agent: ReturnType<typeof hookAgent>) =>
    ({ agent, turnId: null, outcome: "completed", timeline: [] }) as never;
  await announce(turnEnded(hookAgent("L1", "claude", { "slp.role": "lead" })), context);
  await announce(turnEnded(hookAgent("L-old", "claude-lead")), context);
  expect(calls.sent.map((s) => s.agentId)).toEqual(["S1"]);
  expect(calls.sent[0]?.text).toContain("`L1`");
});
