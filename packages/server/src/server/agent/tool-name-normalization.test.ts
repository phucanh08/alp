import { describe, expect, it } from "vitest";

import { getAlpToolLeafName, isAlpToolName } from "@alp/protocol/tool-name-normalization";

describe("isAlpToolName", () => {
  it("detects Claude Code format", () => {
    expect(isAlpToolName("mcp__alp__create_agent")).toBe(true);
    expect(isAlpToolName("mcp__alp__list_agents")).toBe(true);
  });

  it("detects alp_voice variant", () => {
    expect(isAlpToolName("mcp__alp_voice__create_agent")).toBe(true);
    expect(isAlpToolName("alp_voice.create_agent")).toBe(true);
  });

  it("excludes speak tools", () => {
    expect(isAlpToolName("mcp__alp_voice__speak")).toBe(false);
    expect(isAlpToolName("mcp__alp__speak")).toBe(false);
    expect(isAlpToolName("alp.speak")).toBe(false);
  });

  it("detects Codex dot format", () => {
    expect(isAlpToolName("alp.create_agent")).toBe(true);
  });

  it("rejects non-alp tools", () => {
    expect(isAlpToolName("Bash")).toBe(false);
    expect(isAlpToolName("Read")).toBe(false);
    expect(isAlpToolName("mcp__other_server__some_tool")).toBe(false);
  });
});

describe("getAlpToolLeafName", () => {
  it("extracts leaf from Claude Code format", () => {
    expect(getAlpToolLeafName("mcp__alp__create_agent")).toBe("create_agent");
  });

  it("extracts leaf from Codex format", () => {
    expect(getAlpToolLeafName("alp.create_agent")).toBe("create_agent");
    expect(getAlpToolLeafName("alp.list_agents")).toBe("list_agents");
  });

  it("returns null for non-alp tools", () => {
    expect(getAlpToolLeafName("Bash")).toBeNull();
  });
});
