import { describe, expect, it } from "vitest";
import { ensureSupervisorOnLoad, openSupervisor } from "./ensure-supervisor";

const target = { workspaceId: "ws-supervisor", agentId: "agent-supervisor", created: true };

describe("ensureSupervisorOnLoad", () => {
  it("asks the host to ensure the Supervisor once and returns it", async () => {
    const calls: string[] = [];
    const warnings: unknown[] = [];

    const result = await ensureSupervisorOnLoad({
      ensure: async () => {
        calls.push("ensure");
        return target;
      },
      warn: (_message, error) => warnings.push(error),
    });

    expect(result).toEqual({
      workspaceId: "ws-supervisor",
      agentId: "agent-supervisor",
      created: true,
    });
    expect(calls).toEqual(["ensure"]);
    expect(warnings).toEqual([]);
  });

  it("logs a failed ensure and resolves without throwing", async () => {
    const failure = new Error("plugin rpc unavailable");
    const warnings: { message: string; error: unknown }[] = [];

    const result = await ensureSupervisorOnLoad({
      ensure: async () => {
        throw failure;
      },
      warn: (message, error) => warnings.push({ message, error }),
    });

    expect(result).toBeNull();
    expect(warnings).toEqual([{ message: "[slp] Supervisor ensure failed", error: failure }]);
  });
});

describe("openSupervisor", () => {
  it("opens the agent the host ensured", async () => {
    const opened: { agentId: string }[] = [];

    const result = await openSupervisor({
      ensure: async () => ({ ...target, created: false }),
      openAgent: (input) => opened.push(input),
    });

    expect(opened).toEqual([{ agentId: "agent-supervisor" }]);
    expect(result).toEqual({
      workspaceId: "ws-supervisor",
      agentId: "agent-supervisor",
      created: false,
    });
  });

  it("does not navigate when ensure fails", async () => {
    const opened: { agentId: string }[] = [];

    await expect(
      openSupervisor({
        ensure: async () => {
          throw new Error("daemon offline");
        },
        openAgent: (input) => opened.push(input),
      }),
    ).rejects.toThrow("daemon offline");
    expect(opened).toEqual([]);
  });
});
