import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  buildSystemPrompt,
  familyOf,
  providerOptionsFor,
  readDefinition,
  seatOfAgent,
  seatProfileFor,
  stripFrontmatter,
  withLeadAllowedTools,
} from "./seat";

test("seatOfAgent reads the slp.role label on the claude and codex providers only", () => {
  expect(seatOfAgent({ provider: "claude", labels: { "slp.role": "lead" } })).toBe("lead");
  expect(seatOfAgent({ provider: "codex", labels: { "slp.role": "peer" } })).toBe("peer");
  expect(seatOfAgent({ provider: "claude", labels: { "slp.role": "supervisor" } })).toBe(
    "supervisor",
  );
  expect(seatOfAgent({ provider: "claude", labels: { "slp.role": "owner" } })).toBeNull();
  expect(seatOfAgent({ provider: "claude" })).toBeNull();
  expect(seatOfAgent({ provider: "acp", labels: { "slp.role": "lead" } })).toBeNull();
  expect(seatOfAgent({ provider: "claude-lead" })).toBeNull();
  expect(seatOfAgent({ provider: "claude-lead", labels: { "slp.role": "lead" } })).toBeNull();
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
  expect(lead).toContain('provider: "claude/<model>"');
  expect(lead).toContain('labels: {"slp.role": "peer"}');
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

test("a Claude Peer loses Agent and Task and keeps its other options", () => {
  expect(providerOptionsFor("peer", "claude", { allowedTools: ["Bash"] })).toEqual({
    allowedTools: ["Bash"],
    disallowedTools: ["Agent", "Task"],
  });
  expect(providerOptionsFor("peer", "claude", { disallowedTools: ["Task", "WebFetch"] })).toEqual({
    disallowedTools: ["Task", "WebFetch", "Agent"],
  });
});

test("familyOf accepts only the base providers; codex supervisor gets workspace-write sandbox", () => {
  expect(familyOf("claude")).toBe("claude");
  expect(familyOf("codex")).toBe("codex");
  expect(familyOf("codex-peer")).toBeNull();
  expect(familyOf("claude-peer")).toBeNull();
  expect(familyOf("acp")).toBeNull();
  expect(providerOptionsFor("supervisor", "codex", { approval_policy: "never" })).toEqual({
    approval_policy: "never",
    sandbox_mode: "workspace-write",
  });
  const opts = { approval_policy: "on-request" };
  expect(providerOptionsFor("lead", "codex", opts)).toBe(opts);
});

test("seatProfileFor picks the base provider and unattended mode of each family", () => {
  expect(seatProfileFor("claude")).toEqual({ providerId: "claude", modeId: "bypassPermissions" });
  expect(seatProfileFor("codex")).toEqual({ providerId: "codex", modeId: "full-access" });
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

test("a Codex Lead spawns a codex Peer by label in Codex's default approval mode", () => {
  const lead = buildSystemPrompt("lead", "codex", "BODY", null);
  expect(lead).toContain('provider: "codex/<model>"');
  expect(lead).toContain('labels: {"slp.role": "peer"}');
  expect(lead).toContain('settings.modeId: "auto"');
  expect(lead).toContain("settings.thinkingOptionId");
  const claudeLead = buildSystemPrompt("lead", "claude", "BODY", null);
  expect(claudeLead).toContain('settings.modeId: "default"');
});

test("runtime blocks name no retired seat provider and no Gemini", () => {
  for (const seat of ["lead", "peer", "supervisor"] as const) {
    for (const family of ["claude", "codex"] as const) {
      const block = buildSystemPrompt(seat, family, "BODY", null);
      expect(block).not.toMatch(/(claude|codex|gemini)-(lead|peer|supervisor)/);
      expect(block).not.toMatch(/gemini/i);
    }
  }
});
