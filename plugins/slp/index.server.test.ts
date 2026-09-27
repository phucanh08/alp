import type {
  PluginBeforeRequests,
  PluginHookContext,
  PluginLifecycleEvents,
  PluginServerContext,
} from "@getpaseo/plugin/server";
import type { PluginRpcContract } from "@getpaseo/plugin";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import contribute from "./index.server";
import { SEAT_LABEL } from "./server/seat";
import type { SlpSettingsState } from "./server/settings";

/**
 * `contribute(server)` wiring: every hook and RPC `index.server.ts` registers reads the `enabled`
 * setting itself (ruling p11 G1). These tests drive the seam through a fake `PluginServerContext`
 * instead of the individual functions in `server/hooks.ts` / `server/ensure.ts`, which already have
 * their own `enabled` parameter covered elsewhere — this file is the only place the *wiring* (does
 * `contribute` actually read the setting before calling them) is checked.
 */

type OnHandler = (event: never, context: PluginHookContext) => void | Promise<void>;
type BeforeHandler = (
  input: { request: never },
  context: PluginHookContext,
) => unknown | Promise<unknown>;
type RpcHandler = (input: unknown, context: { paseo: unknown }) => unknown;

interface FakeAgentRecord {
  id: string;
  provider: string;
  cwd: string;
  status: string;
  title?: string | null;
  labels?: Record<string, string>;
  workspaceId?: string | null;
}

interface FakeWorkspace {
  id: string;
  projectId?: string;
  projectRootPath: string;
  workspaceDirectory?: string;
  archivingAt?: string | null;
}

/**
 * A fake `PluginServerContext` plus the fake `PaseoApi` its hook/RPC handlers receive, wired
 * together like the daemon would: `contribute(server)` registers against `server`, and the test
 * invokes the captured handlers directly with `hookContext`/`rpcContext`, which read and mutate the
 * same fake host state (`agents`, `workspaces`, `created`, `sent`, `allowed`).
 */
function fakeContext(
  initial: {
    enabled: boolean;
    supervisorCheckMinutes?: number;
    agents?: FakeAgentRecord[];
    workspaces?: FakeWorkspace[];
    /** The daemon's `PASEO_HOME` as the plugin process sees it; unset unless given. */
    paseoHome?: string;
  } = { enabled: true },
) {
  vi.stubEnv("PASEO_HOME", initial.paseoHome);
  let enabled = initial.enabled;
  let supervisorCheckMinutes = initial.supervisorCheckMinutes ?? 10;
  const agents: FakeAgentRecord[] = [...(initial.agents ?? [])];
  const workspaces: FakeWorkspace[] = [...(initial.workspaces ?? [])];
  const created: Array<{ workspaceId: string; labels?: Record<string, string> }> = [];
  const sent: Array<{ agentId: string; text: string }> = [];
  const allowed: Array<{ agentId: string; requestId: string }> = [];
  const invoked: Array<{ pluginId: string; method: string; input: unknown }> = [];
  let nextId = 1;

  const paseo = {
    agents: {
      async list() {
        return { entries: agents.map((agent) => ({ agent })), pageInfo: { nextCursor: null } };
      },
      ref(agentId: string) {
        return {
          async send(text: string) {
            sent.push({ agentId, text });
          },
          async respondToPermission({ requestId }: { requestId: string }) {
            allowed.push({ agentId, requestId });
          },
          timeline: {
            async refetch() {
              return { entries: [] };
            },
          },
        };
      },
    },
    workspaces: {
      async list() {
        return { entries: [...workspaces], pageInfo: { nextCursor: null } };
      },
      async create(options: { source: { kind: "directory"; path: string }; title: string }) {
        const workspace: FakeWorkspace = {
          id: `wks_new${nextId++}`,
          projectRootPath: options.source.path,
          workspaceDirectory: options.source.path,
        };
        workspaces.push(workspace);
        return { id: workspace.id };
      },
      ref(workspaceId: string) {
        return {
          agents: {
            async create(options: {
              config: { provider: string };
              title: string;
              labels: Record<string, string>;
            }) {
              const id = `agent_new${nextId++}`;
              agents.push({
                id,
                provider: options.config.provider,
                cwd: "/r",
                status: "idle",
                title: options.title,
                labels: options.labels,
                workspaceId,
              });
              created.push({ workspaceId, labels: options.labels });
              return { id };
            },
          },
        };
      },
    },
    providers: {
      async listModels() {
        return { models: [{ id: "sonnet", isDefault: true }] };
      },
    },
    plugins: {
      async invoke(pluginId: string, method: string, input: unknown) {
        invoked.push({ pluginId, method, input });
        if (method === "slp-dev.skills.get") {
          const seat = (input as { seat: string }).seat;
          return {
            files:
              seat === "supervisor"
                ? []
                : [{ path: "xia/SKILL.md", content: `XIA FOR ${seat}\n`, executable: false }],
          };
        }
        return { definition: "---\nname: lead\n---\nSLP-DEV LEAD\n", skills: ["xia"] };
      },
    },
  };

  const onHandlers = new Map<string, OnHandler>();
  const beforeHandlers = new Map<string, BeforeHandler>();
  const rpcHandlers = new Map<string, RpcHandler>();

  const server: PluginServerContext = {
    registerSettings: () =>
      ({
        async read(): Promise<SlpSettingsState> {
          return {
            status: "ready",
            revision: "1",
            values: { enabled, supervisorModel: null, supervisorCheckMinutes },
          };
        },
        subscribe: () => () => {},
      }) as never,
    handle: (contract: PluginRpcContract, handler) => {
      rpcHandlers.set(contract.name, handler as RpcHandler);
    },
    before: <Name extends keyof PluginBeforeRequests>(name: Name, handler: never) => {
      beforeHandlers.set(name, handler);
      return () => beforeHandlers.delete(name);
    },
    on: <Name extends keyof PluginLifecycleEvents>(name: Name, handler: never) => {
      onHandlers.set(name, handler);
      return () => onHandlers.delete(name);
    },
    registerProvider: () => {},
  };

  const hookContext: PluginHookContext = {
    paseo: paseo as never,
    signal: new AbortController().signal,
  };

  return {
    server,
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    setSupervisorCheckMinutes: (value: number) => {
      supervisorCheckMinutes = value;
    },
    onHandlers,
    beforeHandlers,
    rpcHandlers,
    hookContext,
    paseo,
    agents,
    workspaces,
    created,
    sent,
    allowed,
    invoked,
  };
}

test("permission_requested does not auto-allow mcp__paseo__ tools for a labelled Lead while SLP is off", async () => {
  const fx = fakeContext({
    enabled: false,
    agents: [
      {
        id: "L1",
        provider: "claude",
        cwd: "/r",
        status: "running",
        labels: { [SEAT_LABEL]: "lead" },
      },
    ],
  });
  contribute(fx.server);
  const handler = fx.onHandlers.get("agent.permission_requested");
  expect(handler).toBeDefined();

  await handler!(
    {
      agent: {
        id: "L1",
        workspaceId: "w1",
        parentAgentId: null,
        provider: "claude",
        cwd: "/r",
        title: "Lead",
        labels: { [SEAT_LABEL]: "lead" },
      },
      request: { id: "perm1", provider: "claude", kind: "tool", name: "mcp__paseo__create_agent" },
    } as never,
    fx.hookContext,
  );

  expect(fx.allowed).toEqual([]);
});

test("turn_ended does not announce a Lead to Supervisors while SLP is off", async () => {
  const fx = fakeContext({
    enabled: false,
    agents: [
      {
        id: "S1",
        provider: "claude",
        cwd: "/sup",
        status: "idle",
        labels: { [SEAT_LABEL]: "supervisor" },
      },
    ],
  });
  contribute(fx.server);
  const handler = fx.onHandlers.get("agent.turn_ended");
  expect(handler).toBeDefined();

  await handler!(
    {
      agent: {
        id: "L1",
        workspaceId: "w1",
        parentAgentId: null,
        provider: "claude",
        cwd: "/r",
        title: "Lead",
        labels: { [SEAT_LABEL]: "lead" },
      },
      turnId: null,
      outcome: { kind: "completed" },
      timeline: [],
    } as never,
    fx.hookContext,
  );

  expect(fx.sent).toEqual([]);
});

test("agent.create passes the request through unchanged while SLP is off", async () => {
  const fx = fakeContext({ enabled: false });
  contribute(fx.server);
  const handler = fx.beforeHandlers.get("agent.create");
  expect(handler).toBeDefined();

  const request = {
    config: { provider: "claude", cwd: "/r", systemPrompt: "EXISTING" },
    labels: { [SEAT_LABEL]: "lead" },
  };
  const result = await handler!({ request: request as never }, fx.hookContext);

  expect(result).toBeUndefined();
});

test("agent.create asks slp-dev through the hook's own Paseo API for the seat rules", async () => {
  const fx = fakeContext({ enabled: true });
  contribute(fx.server);
  const handler = fx.beforeHandlers.get("agent.create");
  expect(handler).toBeDefined();

  const request = {
    config: { provider: "claude", cwd: "/nonexistent-slp-cwd", systemPrompt: "EXISTING" },
    labels: { [SEAT_LABEL]: "lead" },
  };
  const result = (await handler!({ request: request as never }, fx.hookContext)) as {
    config: { systemPrompt: string };
  };

  expect(fx.invoked).toEqual([
    { pluginId: "slp-dev", method: "slp-dev.seat.get", input: { seat: "lead" } },
  ]);
  expect(
    result.config.systemPrompt.startsWith("EXISTING\n\n# Ghế SLP: lead\n\nSLP-DEV LEAD\n\n"),
  ).toBe(true);
  expect(result.config.systemPrompt).toContain(
    "- **Skill của ghế này** (plugin `slp-dev`): `xia`.",
  );
});

test("slp.lead.ensure and slp.supervisor.ensure refuse while SLP is off", async () => {
  const fx = fakeContext({ enabled: false });
  contribute(fx.server);
  const lead = fx.rpcHandlers.get("slp.lead.ensure");
  const supervisor = fx.rpcHandlers.get("slp.supervisor.ensure");
  expect(lead).toBeDefined();
  expect(supervisor).toBeDefined();

  await expect(lead!({ workspaceId: "w1" }, { paseo: fx.paseo })).rejects.toThrow(/SLP disabled/);
  await expect(supervisor!({}, { paseo: fx.paseo })).rejects.toThrow(/SLP disabled/);
});

test(
  "a client-workspace origin recorded while SLP is off is consumed once, not left to match a " +
    "later unrelated workspace after SLP is re-enabled",
  async () => {
    // No workspace is known yet at record time — a worktree's directory does not exist until the
    // daemon creates it, so `projectOfCheckout` finds nothing and the pending entry is a wildcard
    // (`projectId: null`), matching any later worktree workspace. That is what makes it stale-dangerous.
    const fx = fakeContext({ enabled: false });
    contribute(fx.server);
    const beforeCreate = fx.beforeHandlers.get("workspace.create");
    const created = fx.onHandlers.get("workspace.created");
    expect(beforeCreate).toBeDefined();
    expect(created).toBeDefined();

    // A directory-less worktree request from the client, recorded while SLP is off.
    await beforeCreate!(
      { request: { source: { kind: "worktree", cwd: "/repo/w1" } } as never },
      fx.hookContext,
    );
    fx.workspaces.push({
      id: "w1",
      projectId: "proj1",
      projectRootPath: "/repo/w1",
      workspaceDirectory: "/repo/w1",
    });
    // Its own workspace.created fires while still off: no Lead, but the origin entry it matched
    // must not survive to attach itself to a later, unrelated workspace.
    await created!(
      { workspace: { id: "w1", projectId: "proj1", cwd: "/repo/w1" } } as never,
      fx.hookContext,
    );
    expect(fx.created).toEqual([]);

    fx.setEnabled(true);
    fx.workspaces.push({
      id: "w2",
      projectId: "proj2",
      projectRootPath: "/repo/w2",
      workspaceDirectory: "/repo/w2",
    });

    // A second, unrelated worktree workspace (e.g. one a Lead creates for a Peer over MCP) that
    // never went through before("workspace.create") itself.
    await created!(
      { workspace: { id: "w2", projectId: "proj2", cwd: "/repo/w2" } } as never,
      fx.hookContext,
    );
    expect(fx.created).toEqual([]);
  },
);

const MINUTE = 60_000;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

/** A working Lead and an idle Supervisor: the host the Supervisor check nudges about. */
function checkAgents(): FakeAgentRecord[] {
  return [
    {
      id: "L1",
      provider: "claude",
      cwd: "/r",
      status: "running",
      title: "Lead",
      labels: { [SEAT_LABEL]: "lead" },
    },
    {
      id: "S1",
      provider: "claude",
      cwd: "/sup",
      status: "idle",
      labels: { [SEAT_LABEL]: "supervisor" },
    },
  ];
}

/** Fires `agent.turn_started` for L1, which hands the plugin its Paseo API. */
async function startLeadTurn(fx: ReturnType<typeof fakeContext>) {
  const handler = fx.onHandlers.get("agent.turn_started");
  expect(handler).toBeDefined();
  await handler!(
    {
      agent: {
        id: "L1",
        workspaceId: "w1",
        parentAgentId: null,
        provider: "claude",
        cwd: "/r",
        title: "Lead",
        labels: { [SEAT_LABEL]: "lead" },
      },
      turnId: null,
    } as never,
    fx.hookContext,
  );
}

test("the Supervisor check reads supervisorCheckMinutes every tick, so a change needs no restart", async () => {
  vi.useFakeTimers();
  const fx = fakeContext({ enabled: true, supervisorCheckMinutes: 0, agents: checkAgents() });
  contribute(fx.server);
  await startLeadTurn(fx);

  await vi.advanceTimersByTimeAsync(15 * MINUTE);
  expect(fx.sent).toEqual([]);

  fx.setSupervisorCheckMinutes(5);
  await vi.advanceTimersByTimeAsync(5 * MINUTE);
  expect(fx.sent).toEqual([]);
  await vi.advanceTimersByTimeAsync(MINUTE);
  expect(fx.sent).toHaveLength(1);
  expect(fx.sent[0].agentId).toBe("S1");
  expect(fx.sent[0].text.startsWith("[plugin slp] SLP-CHECK\nLead `L1`")).toBe(true);
});

test("the Supervisor check sends nothing while SLP is off", async () => {
  vi.useFakeTimers();
  const fx = fakeContext({ enabled: false, agents: checkAgents() });
  contribute(fx.server);
  await startLeadTurn(fx);

  await vi.advanceTimersByTimeAsync(30 * MINUTE);
  expect(fx.sent).toEqual([]);

  fx.setEnabled(true);
  await startLeadTurn(fx);
  await vi.advanceTimersByTimeAsync(11 * MINUTE);
  expect(fx.sent).toHaveLength(1);
});

test("the cleanup contribute returns stops the Supervisor check", async () => {
  vi.useFakeTimers();
  const fx = fakeContext({ enabled: true, agents: checkAgents() });
  const cleanup = contribute(fx.server);
  await startLeadTurn(fx);

  cleanup?.();
  await vi.advanceTimersByTimeAsync(30 * MINUTE);
  expect(fx.sent).toEqual([]);
});

async function temporaryPaseoHome(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "slp-index-home-"));
}

interface CreateResult {
  config: { providerOptions?: Record<string, unknown> };
}

test("agent.create gives a Claude Lead its seat directory under PASEO_HOME as a local plugin", async () => {
  const paseoHome = await temporaryPaseoHome();
  const fx = fakeContext({ enabled: true, paseoHome });
  contribute(fx.server);

  const result = (await fx.beforeHandlers.get("agent.create")!(
    {
      request: {
        config: { provider: "claude", cwd: "/nonexistent-slp-cwd" },
        labels: { [SEAT_LABEL]: "lead" },
      } as never,
    },
    fx.hookContext,
  )) as CreateResult;

  const directory = path.join(paseoHome, "slp", "seat-skills", "lead");
  expect(result.config.providerOptions).toEqual({
    allowedTools: ["mcp__paseo__*"],
    plugins: [{ type: "local", path: directory }],
  });
  expect(fx.invoked).toContainEqual({
    pluginId: "slp-dev",
    method: "slp-dev.skills.get",
    input: { seat: "lead" },
  });
  expect(
    JSON.parse(await readFile(path.join(directory, ".claude-plugin", "plugin.json"), "utf8")),
  ).toMatchObject({ name: "slp-lead" });
  expect(await readFile(path.join(directory, "skills", "xia", "SKILL.md"), "utf8")).toBe(
    "XIA FOR lead\n",
  );
});

test("agent.create gives a Codex Peer its seat directory's skills/ as an extra root", async () => {
  const paseoHome = await temporaryPaseoHome();
  const fx = fakeContext({ enabled: true, paseoHome });
  contribute(fx.server);

  const result = (await fx.beforeHandlers.get("agent.create")!(
    {
      request: {
        config: { provider: "codex", cwd: "/nonexistent-slp-cwd" },
        labels: { [SEAT_LABEL]: "peer" },
      } as never,
    },
    fx.hookContext,
  )) as CreateResult;

  expect(result.config.providerOptions?.skills).toEqual({
    extraRoots: [path.join(paseoHome, "slp", "seat-skills", "peer", "skills")],
  });
});

test("the first Claude/Codex session open writes every seat directory, once", async () => {
  const paseoHome = await temporaryPaseoHome();
  const fx = fakeContext({ enabled: true, paseoHome });
  contribute(fx.server);
  const sessionOpen = fx.beforeHandlers.get("agent.session_open")!;
  const open = (provider: string) =>
    sessionOpen(
      {
        request: {
          agentId: "a1",
          workspaceId: null,
          provider,
          cwd: "/r",
          reason: "resume",
          purpose: "interactive",
          env: {},
        } as never,
      },
      fx.hookContext,
    );

  expect(await open("acp")).toBeUndefined();
  expect(fx.invoked).toEqual([]);
  expect(await open("claude")).toBeUndefined();
  expect((await readdir(path.join(paseoHome, "slp", "seat-skills"))).sort()).toEqual([
    "lead",
    "peer",
  ]);
  const calls = fx.invoked.length;
  await open("codex");
  expect(fx.invoked.length).toBe(calls);
});

test("without PASEO_HOME a seat is created without skills and nothing asks for them", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const fx = fakeContext({ enabled: true });
  contribute(fx.server);

  const result = (await fx.beforeHandlers.get("agent.create")!(
    {
      request: {
        config: { provider: "claude", cwd: "/nonexistent-slp-cwd" },
        labels: { [SEAT_LABEL]: "peer" },
      } as never,
    },
    fx.hookContext,
  )) as CreateResult;

  expect(result.config.providerOptions).toEqual({ disallowedTools: ["Agent", "Task"] });
  expect(fx.invoked.map((call) => call.method)).toEqual(["slp-dev.seat.get"]);
});
