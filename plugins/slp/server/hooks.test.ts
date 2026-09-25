import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import type { AgentLister } from "./discovery";
import { withSeatConfig } from "./hooks";

const agents: AgentLister = {
  async list() {
    return {
      entries: [
        {
          agent: {
            id: "S1",
            provider: "claude-supervisor",
            cwd: "/sup",
            status: "idle",
            title: "Supervisor",
          },
        },
        {
          agent: { id: "L1", provider: "claude-lead", cwd: "/r/a", status: "idle", title: "Lead" },
        },
      ],
      pageInfo: { nextCursor: null },
    };
  },
};

async function request(provider: string) {
  const cwd = await mkdtemp(path.join(tmpdir(), "slp-hooks-"));
  return {
    config: {
      provider,
      cwd,
      systemPrompt: "EXISTING",
      providerOptions: { allowedTools: ["Bash"] },
    },
  };
}

test("agent.create for a Lead injects the bundled seat rules, runtime block, Supervisor roster, and Paseo tools", async () => {
  const result = await withSeatConfig((await request("claude-lead")) as never, agents);
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
  const result = await withSeatConfig((await request("claude-supervisor")) as never, agents);
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
  expect(await withSeatConfig((await request("claude")) as never, agents)).toBeUndefined();
});

test("agent.create for a Codex Peer turns off multi_agent and sandboxes writes; a Claude Peer gets neither", async () => {
  const codex = await withSeatConfig((await request("codex-peer")) as never, agents);
  const codexOptions = (codex?.config as { providerOptions?: Record<string, unknown> } | undefined)
    ?.providerOptions;
  expect(codexOptions).toEqual({
    allowedTools: ["Bash"],
    sandbox_mode: "workspace-write",
    features: { multi_agent: false },
  });

  const claude = await withSeatConfig((await request("claude-peer")) as never, agents);
  const claudeOptions = (
    claude?.config as { providerOptions?: Record<string, unknown> } | undefined
  )?.providerOptions;
  expect(claudeOptions).toEqual({ allowedTools: ["Bash"] });
  expect(claudeOptions).not.toHaveProperty("features");
  expect(claudeOptions).not.toHaveProperty("sandbox_mode");
});
