import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  buildSystemPrompt,
  familyOf,
  providerOptionsFor,
  readDefinition,
  seatOf,
  seatProfileFor,
  stripFrontmatter,
  withLeadAllowedTools,
} from "./seat";

test("seatOf maps only the SLP provider profiles", () => {
  expect(seatOf("claude-lead")).toBe("lead");
  expect(seatOf("claude-peer")).toBe("peer");
  expect(seatOf("claude-supervisor")).toBe("supervisor");
  expect(seatOf("claude")).toBeNull();
  expect(seatOf("codex")).toBeNull();
  expect(seatOf("claude-lead/claude-opus-5-5")).toBeNull();
});

test("stripFrontmatter drops the leading YAML block and keeps the body", () => {
  const md = "---\nname: lead\ntools: Agent(peer)\n---\n# Lead\n\nBody.";
  expect(stripFrontmatter(md)).toBe("# Lead\n\nBody.");
  expect(stripFrontmatter("# No frontmatter\n---\nx")).toBe("# No frontmatter\n---\nx");
});

test("readDefinition prefers .slp/agents in the agent cwd", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "slp-plugin-"));
  await mkdir(path.join(cwd, ".slp", "agents"), { recursive: true });
  await writeFile(path.join(cwd, ".slp", "agents", "peer.md"), "---\nname: peer\n---\nPEER BODY\n");
  const def = await readDefinition(cwd, "peer");
  expect(def).toEqual({
    source: path.join(cwd, ".slp", "agents", "peer.md"),
    body: "PEER BODY",
  });
});

test("readDefinition falls back to the bundled seat file without its frontmatter", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "slp-plugin-"));
  const def = await readDefinition(cwd, "lead");
  expect(def.source).toBe("bundled");
  expect(def.body.startsWith("---")).toBe(false);
  expect(def.body).not.toMatch(/^name: lead$/m);
  expect(def.body).toMatch(/^# /);
});

test("readDefinition ignores .claude/agents and falls back to bundled", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "slp-plugin-"));
  await mkdir(path.join(cwd, ".claude", "agents"), { recursive: true });
  await writeFile(
    path.join(cwd, ".claude", "agents", "peer.md"),
    "---\nname: peer\n---\nCLAUDE CODE PEER BODY\n",
  );
  const def = await readDefinition(cwd, "peer");
  expect(def.source).toBe("bundled");
  expect(def.body).not.toMatch(/CLAUDE CODE PEER BODY/);
});

test("buildSystemPrompt joins existing prompt, seat definition, and the seat runtime block", () => {
  const lead = buildSystemPrompt("lead", "claude", "BODY", "EXISTING");
  expect(lead.startsWith("EXISTING\n\n# Ghế SLP: lead\n\nBODY")).toBe(true);
  expect(lead).toMatch(/## SLP-RUNTIME: alp/);
  expect(lead).toMatch(/create_agent/);
  const peer = buildSystemPrompt("peer", "claude", "BODY", null);
  expect(peer.startsWith("# Ghế SLP: peer")).toBe(true);
  expect(peer).toMatch(/Runtime: alp/);
  expect(peer).not.toMatch(/Spawn peer/);
});

test("Lead runtime block carries the model and effort rule for Peers", () => {
  const lead = buildSystemPrompt("lead", "claude", "BODY", null);
  expect(lead).toContain('provider: "claude-peer/<model>"');
  expect(lead).toContain("settings.thinkingOptionId");
  expect(lead).toMatch(/low.*medium/);
  expect(lead).toMatch(/high/);
  expect(lead).toContain("Model: <model> · Effort: <effort> — <");
  expect(buildSystemPrompt("peer", "claude", "BODY", null)).not.toContain("thinkingOptionId");
});

test("withLeadAllowedTools adds the Paseo wildcard, keeps existing tools, never duplicates", () => {
  expect(withLeadAllowedTools(undefined)).toEqual({ allowedTools: ["mcp__paseo__*"] });
  const merged = withLeadAllowedTools({ allowedTools: ["Bash", "mcp__paseo__*"], model: "x" });
  expect(merged).toEqual({ allowedTools: ["Bash", "mcp__paseo__*"], model: "x" });
});

test("supervisor loses write and spawn tools and gets the Paseo wildcard", () => {
  const opts = providerOptionsFor("supervisor", "claude", { disallowedTools: ["WebSearch"] });
  expect(opts).toEqual({
    allowedTools: ["mcp__paseo__*"],
    disallowedTools: ["WebSearch", "Write", "Edit", "MultiEdit", "NotebookEdit", "Agent", "Task"],
  });
  const prompt = buildSystemPrompt("supervisor", "claude", "BODY", null);
  expect(prompt).toMatch(/Không bao giờ.*send_agent_prompt.*tới peer/);
  expect(prompt).not.toMatch(/Spawn peer/);
});

test("peer providerOptions pass through by reference", () => {
  const opts = { allowedTools: ["Bash"] };
  expect(providerOptionsFor("peer", "claude", opts)).toBe(opts);
  expect(providerOptionsFor("peer", "claude", undefined)).toBeUndefined();
});

test("codex profiles map to seats; codex supervisor gets workspace-write sandbox", () => {
  expect(seatOf("codex-lead")).toBe("lead");
  expect(familyOf("codex-peer")).toBe("codex");
  expect(familyOf("claude-peer")).toBe("claude");
  expect(familyOf("codex")).toBeNull();
  expect(providerOptionsFor("supervisor", "codex", { approval_policy: "never" })).toEqual({
    approval_policy: "never",
    sandbox_mode: "workspace-write",
  });
  const opts = { approval_policy: "on-request" };
  expect(providerOptionsFor("lead", "codex", opts)).toBe(opts);
});

test("seatProfileFor picks the provider profile and unattended mode of each family", () => {
  expect(seatProfileFor("claude", "lead")).toEqual({
    providerId: "claude-lead",
    modeId: "bypassPermissions",
  });
  expect(seatProfileFor("claude", "supervisor")).toEqual({
    providerId: "claude-supervisor",
    modeId: "bypassPermissions",
  });
  expect(seatProfileFor("codex", "lead")).toEqual({
    providerId: "codex-lead",
    modeId: "full-access",
  });
  expect(seatProfileFor("codex", "peer")).toEqual({
    providerId: "codex-peer",
    modeId: "full-access",
  });
  expect(seatProfileFor("codex", "supervisor")).toEqual({
    providerId: "codex-supervisor",
    modeId: "full-access",
  });
});

test("codex peer cannot spawn agents and writes only inside its sandbox", () => {
  expect(
    providerOptionsFor("peer", "codex", {
      approval_policy: "never",
      sandbox_mode: "danger-full-access",
      features: { network_proxy: true, multi_agent: true },
    }),
  ).toEqual({
    approval_policy: "never",
    sandbox_mode: "workspace-write",
    features: { network_proxy: true, multi_agent: false },
  });
  expect(providerOptionsFor("peer", "codex", undefined)).toEqual({
    sandbox_mode: "workspace-write",
    features: { multi_agent: false },
  });
});

test("a Codex Lead spawns codex-peer in Codex's default approval mode", () => {
  const lead = buildSystemPrompt("lead", "codex", "BODY", null);
  expect(lead).toContain('provider: "codex-peer/<model>"');
  expect(lead).toContain('settings.modeId: "auto"');
  expect(lead).not.toContain("claude-peer");
  expect(lead).toContain("settings.thinkingOptionId");
  const claudeLead = buildSystemPrompt("lead", "claude", "BODY", null);
  expect(claudeLead).toContain('settings.modeId: "default"');
  expect(claudeLead).not.toContain("codex-peer");
});

test("gemini profiles map to seats with no fixed unattended or spawn mode", () => {
  expect(seatOf("gemini-lead")).toBe("lead");
  expect(seatOf("gemini-peer")).toBe("peer");
  expect(seatOf("gemini-supervisor")).toBe("supervisor");
  expect(familyOf("gemini-peer")).toBe("gemini");
  expect(familyOf("gemini")).toBeNull();
  expect(seatProfileFor("gemini", "lead")).toEqual({ providerId: "gemini-lead" });
  expect(seatProfileFor("gemini", "lead")).not.toHaveProperty("modeId");
});

test("a Gemini Lead spawns gemini-peer with no settings.modeId", () => {
  const lead = buildSystemPrompt("lead", "gemini", "BODY", null);
  expect(lead).toContain('provider: "gemini-peer/<model>"');
  expect(lead).not.toContain("settings.modeId:");
  expect(lead).toMatch(/không set.*settings\.modeId/);
  expect(lead).toContain("settings.thinkingOptionId");
  expect(lead).toMatch(/không đoán id/);
});

test("gemini runtime block names its skill file path and steer stays generic-ACP", () => {
  const peer = buildSystemPrompt("peer", "gemini", "BODY", null);
  expect(peer).toMatch(/~\/\.agents\/skills\/<tên>\/SKILL\.md/);
  expect(peer).toMatch(/Provider ACP \(không phải Claude\/Codex\) vẫn thay lượt đang chạy/);
});

test("gemini providerOptionsFor falls back to the claude-shaped branch (no codex-only rules)", () => {
  expect(providerOptionsFor("peer", "gemini", { allowedTools: ["Bash"] })).toEqual({
    allowedTools: ["Bash"],
  });
  expect(providerOptionsFor("lead", "gemini", undefined)).toEqual({
    allowedTools: ["mcp__paseo__*"],
  });
});
