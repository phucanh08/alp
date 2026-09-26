import { expect, test } from "vitest";
import { runtimeBlock } from "./runtime-block";
import { PEER_DISABLED_PASEO_TOOLS } from "./seat";

const FAMILIES = ["claude", "codex"] as const;

/**
 * Built independently from `PEER_DISABLED_PASEO_TOOLS`, not by calling the production code, so the
 * check does not just restate `runtime-block.ts`'s own formatting choice back at it. Checked as one
 * contiguous substring, not tool-by-tool, so a single tool dropped from the list cannot hide behind
 * an unrelated, independent mention of that same tool name elsewhere in the block (e.g. the Lead's
 * own `respond_to_permission` reply instruction).
 */
const PEER_TOOL_CUT_TEXT = PEER_DISABLED_PASEO_TOOLS.map((tool) => `\`${tool}\``).join(", ");

test("the Lead's Peer-lock line names exactly the Paseo tools PEER_DISABLED_PASEO_TOOLS cuts", () => {
  for (const family of FAMILIES) {
    expect(runtimeBlock("lead", family)).toContain(PEER_TOOL_CUT_TEXT);
  }
});

test("the Peer's own block names exactly the Paseo tools PEER_DISABLED_PASEO_TOOLS cuts", () => {
  for (const family of FAMILIES) {
    expect(runtimeBlock("peer", family)).toContain(PEER_TOOL_CUT_TEXT);
  }
});

test("a Peer carrying slp.origin gets the independent-Peer paragraph; one without it does not", () => {
  for (const family of FAMILIES) {
    expect(runtimeBlock("peer", family)).not.toContain("không có Lead nào giao brief");
    expect(runtimeBlock("peer", family, "human")).toContain("không có Lead nào giao brief");
    expect(runtimeBlock("peer", family, "schedule")).toContain("không có Lead nào giao brief");
  }
});

test("a Lead or Supervisor block never gets the independent-Peer paragraph, origin or not", () => {
  for (const family of FAMILIES) {
    expect(runtimeBlock("lead", family)).not.toContain("không có Lead nào giao brief");
    expect(runtimeBlock("supervisor", family)).not.toContain("không có Lead nào giao brief");
  }
});
