import { describe, expect, it } from "vitest";
import {
  collectSlpSystemWorkspaceIds,
  SLP_ROLE_LABEL,
  SLP_SUPERVISOR_ROLE,
} from "./system-workspaces";

describe("collectSlpSystemWorkspaceIds", () => {
  it("returns the workspace of each live agent labelled slp.role=supervisor", () => {
    const ids = collectSlpSystemWorkspaceIds([
      { workspaceId: "ws-supervisor", labels: { "slp.role": "supervisor" }, archivedAt: null },
      { workspaceId: "ws-lead", labels: { "slp.role": "lead" }, archivedAt: null },
      { workspaceId: "ws-plain", labels: {}, archivedAt: null },
    ]);

    expect([...ids]).toEqual(["ws-supervisor"]);
  });

  it("ignores archived supervisors and supervisors without a workspace", () => {
    const ids = collectSlpSystemWorkspaceIds([
      {
        workspaceId: "ws-archived",
        labels: { "slp.role": "supervisor" },
        archivedAt: new Date("2026-09-01T00:00:00Z"),
      },
      { workspaceId: undefined, labels: { "slp.role": "supervisor" }, archivedAt: null },
      { workspaceId: "   ", labels: { "slp.role": "supervisor" } },
    ]);

    expect(ids.size).toBe(0);
  });

  it("keeps the workspace hidden while any supervisor in it is still live", () => {
    const ids = collectSlpSystemWorkspaceIds([
      {
        workspaceId: "ws-supervisor",
        labels: { "slp.role": "supervisor" },
        archivedAt: new Date("2026-09-01T00:00:00Z"),
      },
      { workspaceId: " ws-supervisor ", labels: { "slp.role": "supervisor" }, archivedAt: null },
    ]);

    expect([...ids]).toEqual(["ws-supervisor"]);
  });

  it("exposes the label contract used by the slp plugin", () => {
    expect(SLP_ROLE_LABEL).toBe("slp.role");
    expect(SLP_SUPERVISOR_ROLE).toBe("supervisor");
  });
});
