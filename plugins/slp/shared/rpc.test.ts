import { expect, test } from "vitest";
import { slpLeadEnsure, slpSupervisorEnsure } from "./rpc";

test("slp.supervisor.ensure takes an empty object and returns workspace, agent, created", () => {
  expect(slpSupervisorEnsure.name).toBe("slp.supervisor.ensure");
  expect(slpSupervisorEnsure.input.parse({})).toEqual({});
  const output = { workspaceId: "wks_0123456789abcdef", agentId: "a1", created: true };
  expect(slpSupervisorEnsure.output.parse(output)).toEqual(output);
  expect(() => slpSupervisorEnsure.output.parse({ workspaceId: "w", agentId: "a" })).toThrow();
});

test("slp.lead.ensure takes a workspace id and returns agent, created", () => {
  expect(slpLeadEnsure.name).toBe("slp.lead.ensure");
  expect(slpLeadEnsure.input.parse({ workspaceId: "wks_1" })).toEqual({ workspaceId: "wks_1" });
  expect(() => slpLeadEnsure.input.parse({})).toThrow();
  expect(slpLeadEnsure.output.parse({ agentId: "a1", created: false })).toEqual({
    agentId: "a1",
    created: false,
  });
  expect(() => slpLeadEnsure.output.parse({ agentId: "a1" })).toThrow();
});
