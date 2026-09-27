import { expect, test } from "vitest";
import { runtimeBlock } from "./runtime-block";
import { PEER_DISABLED_ALP_TOOLS } from "./seat";

const FAMILIES = ["claude", "codex"] as const;

/**
 * Built independently from `PEER_DISABLED_ALP_TOOLS`, not by calling the production code, so the
 * check does not just restate `runtime-block.ts`'s own formatting choice back at it. Checked as one
 * contiguous substring, not tool-by-tool, so a single tool dropped from the list cannot hide behind
 * an unrelated, independent mention of that same tool name elsewhere in the block (e.g. the Lead's
 * own `respond_to_permission` reply instruction).
 */
const PEER_TOOL_CUT_TEXT = PEER_DISABLED_ALP_TOOLS.map((tool) => `\`${tool}\``).join(", ");

test("the Lead's Peer-lock line names exactly the Alp tools PEER_DISABLED_ALP_TOOLS cuts", () => {
  for (const family of FAMILIES) {
    expect(runtimeBlock("lead", family)).toContain(PEER_TOOL_CUT_TEXT);
  }
});

test("the Peer's own block names exactly the Alp tools PEER_DISABLED_ALP_TOOLS cuts", () => {
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

test("Nạp skill names slp-<ghế>:<tên> for both families and never ~/.codex/skills", () => {
  for (const family of FAMILIES) {
    const block = runtimeBlock("peer", family);
    expect(block).toContain("slp-<ghế>:<tên>");
    expect(block).not.toContain("~/.codex/skills");
  }
});

test("Skill của ghế này lists the seat's skills qualified slp-<seat>:<name>, the form each family loads", () => {
  expect(runtimeBlock("peer", "claude", null, ["xia", "smart-commits"])).toContain(
    "`slp-peer:xia`, `slp-peer:smart-commits`",
  );
  expect(runtimeBlock("lead", "codex", null, ["xia"])).toContain("`slp-lead:xia`");
});

test("a Codex seat with a real skill directory gets its literal skills root named in the block", () => {
  const block = runtimeBlock("peer", "codex", null, [], true, "/home/.alp/slp/seat-skills/peer");
  expect(block).toContain("seat dir của bạn: `/home/.alp/slp/seat-skills/peer/skills`");
});

test("a seat with no skill directory gets no seat-dir path line, on either family", () => {
  for (const family of FAMILIES) {
    expect(runtimeBlock("peer", family)).not.toMatch(/seat dir của bạn: `/);
  }
});

test("a Claude seat with a real skill directory still gets no literal path — it loads by name", () => {
  const block = runtimeBlock("peer", "claude", null, [], true, "/home/.alp/slp/seat-skills/peer");
  expect(block).not.toMatch(/seat dir của bạn: `/);
});
