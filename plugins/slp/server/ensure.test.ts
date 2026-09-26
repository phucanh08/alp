import { expect, test } from "vitest";
import type { AgentEntryLike } from "./discovery";
import {
  type EnsureApi,
  type SeatAgentCreate,
  type WorkspaceLike,
  ClientWorkspaceOrigins,
  ensureLead,
  ensureSupervisor,
  handleWorkspaceCreated,
  pickDefaultModel,
} from "./ensure";
import { resolvePaseoHome, supervisorDirectory } from "./paths";

const SUPERVISOR_DIR = "/home/u/.alp/supervisor";

interface FakeHost {
  api: EnsureApi;
  agents: AgentEntryLike[];
  workspaces: WorkspaceLike[];
  created: Array<{ workspaceId: string; options: SeatAgentCreate }>;
  createdWorkspaces: Array<{ path: string; title: string }>;
  sent: Array<{ agentId: string; text: string }>;
  /** Agent ids whose resume the fake daemon rejects, like a lost provider session. */
  failResume: Set<string>;
}

function fakeHost(
  initial: { agents?: AgentEntryLike[]; workspaces?: WorkspaceLike[] } = {},
): FakeHost {
  const host: FakeHost = {
    agents: [...(initial.agents ?? [])],
    workspaces: [...(initial.workspaces ?? [])],
    created: [],
    createdWorkspaces: [],
    sent: [],
    failResume: new Set(),
    api: undefined as unknown as EnsureApi,
  };
  let nextId = 1;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
  host.api = {
    agents: {
      async list() {
        await tick();
        return { entries: [...host.agents], pageInfo: { nextCursor: null } };
      },
      ref(agentId) {
        return {
          async send(text) {
            await tick();
            if (host.failResume.has(agentId)) throw new Error(`Agent ${agentId} cannot resume`);
            host.sent.push({ agentId, text });
            // The daemon resumes a closed agent before it starts the turn.
            const entry = host.agents.find((e) => e.agent.id === agentId);
            if (entry) entry.agent.status = "running";
          },
        };
      },
    },
    workspaces: {
      async list() {
        await tick();
        return { entries: [...host.workspaces], pageInfo: { nextCursor: null } };
      },
      async create(options) {
        await tick();
        const workspace = {
          id: `wks_new${nextId++}`,
          projectRootPath: options.source.path,
          workspaceDirectory: options.source.path,
        };
        host.createdWorkspaces.push({ path: options.source.path, title: options.title });
        host.workspaces.push(workspace);
        return { id: workspace.id };
      },
      ref(workspaceId) {
        return {
          agents: {
            async create(options) {
              await tick();
              const id = `agent${nextId++}`;
              host.created.push({ workspaceId, options });
              host.agents.push({
                agent: {
                  id,
                  provider: options.config.provider.split("/")[0],
                  cwd: "/somewhere",
                  status: "idle",
                  workspaceId,
                  title: options.title,
                  labels: options.labels,
                },
              });
              return { id };
            },
          },
        };
      },
    },
    providers: {
      async listModels() {
        return {
          models: [
            { id: "claude-sonnet-5", isDefault: false },
            { id: "claude-opus-5-5", isDefault: true },
          ],
        };
      },
    },
  };
  return host;
}

const repo: WorkspaceLike = {
  id: "wks_repo",
  projectRootPath: "/r/app",
  workspaceDirectory: "/r/app",
};
const supervisorWorkspace: WorkspaceLike = {
  id: "wks_sup",
  projectRootPath: SUPERVISOR_DIR,
  workspaceDirectory: SUPERVISOR_DIR,
};

test("resolvePaseoHome mirrors the daemon: PASEO_HOME wins, ~ expands, default is ~/.alp", () => {
  expect(resolvePaseoHome({}, "/home/u")).toBe("/home/u/.alp");
  expect(resolvePaseoHome({ PASEO_HOME: "~/dev-home" }, "/home/u")).toBe("/home/u/dev-home");
  expect(resolvePaseoHome({ PASEO_HOME: "/srv/alp" }, "/home/u")).toBe("/srv/alp");
  expect(supervisorDirectory({}, "/home/u")).toBe(SUPERVISOR_DIR);
});

test("pickDefaultModel prefers the default model, then the first selectable one", () => {
  expect(pickDefaultModel([{ id: "a" }, { id: "b", isDefault: true }])).toBe("b");
  expect(pickDefaultModel([{ id: "a", isSelectable: false }, { id: "c" }])).toBe("c");
  expect(pickDefaultModel([])).toBeNull();
  expect(pickDefaultModel(undefined)).toBeNull();
});

test("ensureLead creates one Lead with the contract settings, then reuses it", async () => {
  const host = fakeHost({ workspaces: [repo] });
  const first = await ensureLead(host.api, "wks_repo", { supervisorDirectory: SUPERVISOR_DIR });
  expect(first.created).toBe(true);
  expect(host.created).toEqual([
    {
      workspaceId: "wks_repo",
      options: {
        config: { provider: "claude/claude-opus-5-5", modeId: "bypassPermissions" },
        title: "Lead",
        labels: { "slp.role": "lead" },
      },
    },
  ]);
  const second = await ensureLead(host.api, "wks_repo", { supervisorDirectory: SUPERVISOR_DIR });
  expect(second).toEqual({ agentId: first.agentId, created: false });
  expect(host.created).toHaveLength(1);
});

test("ensureLead is idempotent under concurrent calls for the same workspace", async () => {
  const host = fakeHost({ workspaces: [repo] });
  const results = await Promise.all([
    ensureLead(host.api, "wks_repo", { supervisorDirectory: SUPERVISOR_DIR }),
    ensureLead(host.api, "wks_repo", { supervisorDirectory: SUPERVISOR_DIR }),
    ensureLead(host.api, "wks_repo", { supervisorDirectory: SUPERVISOR_DIR }),
  ]);
  expect(host.created).toHaveLength(1);
  expect(new Set(results.map((r) => r.agentId)).size).toBe(1);
  expect(results.filter((r) => r.created)).toHaveLength(1);
});

test("ensureLead ignores Leads of other workspaces and archived or closed Leads", async () => {
  const host = fakeHost({
    workspaces: [repo],
    agents: [
      {
        agent: {
          id: "L-other",
          provider: "claude",
          cwd: "/r/b",
          status: "idle",
          workspaceId: "wks_b",
          labels: { "slp.role": "lead" },
        },
      },
      {
        agent: {
          id: "L-closed",
          provider: "claude",
          cwd: "/r/app",
          status: "closed",
          workspaceId: "wks_repo",
          labels: { "slp.role": "lead" },
        },
      },
    ],
  });
  const result = await ensureLead(host.api, "wks_repo", { supervisorDirectory: SUPERVISOR_DIR });
  expect(result.created).toBe(true);
});

test("ensureLead refuses the Supervisor system workspace and unknown workspaces", async () => {
  const host = fakeHost({ workspaces: [supervisorWorkspace] });
  await expect(
    ensureLead(host.api, "wks_sup", { supervisorDirectory: SUPERVISOR_DIR }),
  ).rejects.toThrow(/Supervisor/);
  await expect(
    ensureLead(host.api, "wks_missing", { supervisorDirectory: SUPERVISOR_DIR }),
  ).rejects.toThrow(/wks_missing/);
  expect(host.created).toHaveLength(0);
});

test("ensureSupervisor creates the system workspace and Supervisor once per host", async () => {
  const host = fakeHost({ workspaces: [repo] });
  const made: string[] = [];
  const deps = {
    supervisorDirectory: SUPERVISOR_DIR,
    makeDirectory: async (dir: string) => void made.push(dir),
  };
  const [a, b] = await Promise.all([
    ensureSupervisor(host.api, deps),
    ensureSupervisor(host.api, deps),
  ]);
  expect(made).toContain(SUPERVISOR_DIR);
  expect(host.createdWorkspaces).toEqual([{ path: SUPERVISOR_DIR, title: "SLP Supervisor" }]);
  expect(host.created).toEqual([
    {
      workspaceId: a.workspaceId,
      options: {
        config: { provider: "claude/claude-opus-5-5", modeId: "bypassPermissions" },
        title: "Supervisor",
        labels: { "slp.role": "supervisor" },
      },
    },
  ]);
  expect(a.created).toBe(true);
  expect(b).toEqual({ workspaceId: a.workspaceId, agentId: a.agentId, created: false });
});

test("ensureSupervisor reuses a live Supervisor and an existing system workspace", async () => {
  const live = fakeHost({
    workspaces: [supervisorWorkspace],
    agents: [
      {
        agent: {
          id: "S1",
          provider: "claude",
          cwd: SUPERVISOR_DIR,
          status: "idle",
          workspaceId: "wks_sup",
          labels: { "slp.role": "supervisor" },
        },
      },
    ],
  });
  const deps = { supervisorDirectory: SUPERVISOR_DIR, makeDirectory: async () => {} };
  expect(await ensureSupervisor(live.api, deps)).toEqual({
    workspaceId: "wks_sup",
    agentId: "S1",
    created: false,
  });
  expect(live.created).toHaveLength(0);

  const archived = fakeHost({
    workspaces: [supervisorWorkspace],
    agents: [
      {
        agent: {
          id: "S0",
          provider: "claude",
          cwd: SUPERVISOR_DIR,
          status: "idle",
          workspaceId: "wks_sup",
          labels: { "slp.role": "supervisor" },
          archivedAt: "2026-09-01",
        },
      },
    ],
  });
  const result = await ensureSupervisor(archived.api, deps);
  expect(result).toMatchObject({ workspaceId: "wks_sup", created: true });
  expect(archived.createdWorkspaces).toHaveLength(0);
});

test("workspace.created makes a Lead only for client-created workspaces, never the Supervisor one", async () => {
  const host = fakeHost({ workspaces: [repo, supervisorWorkspace] });
  const origins = new ClientWorkspaceOrigins();
  const deps = { supervisorDirectory: SUPERVISOR_DIR };

  // Created by an agent over MCP (no before-hook): no Lead.
  expect(
    await handleWorkspaceCreated(
      host.api,
      origins,
      { id: "wks_repo", projectId: "p1", cwd: "/r/app" },
      deps,
    ),
  ).toBeNull();

  // System workspace, even when it came through the client path: no Lead.
  origins.record({ source: { kind: "directory", path: SUPERVISOR_DIR } });
  expect(
    await handleWorkspaceCreated(
      host.api,
      origins,
      { id: "wks_sup", projectId: "p9", cwd: SUPERVISOR_DIR },
      deps,
    ),
  ).toBeNull();
  expect(host.created).toHaveLength(0);

  // Client-created directory workspace: Lead.
  origins.record({ source: { kind: "directory", path: "/r/app" } });
  const result = await handleWorkspaceCreated(
    host.api,
    origins,
    { id: "wks_repo", projectId: "p1", cwd: "/r/app" },
    deps,
  );
  expect(result?.created).toBe(true);
  expect(host.created.map((c) => c.workspaceId)).toEqual(["wks_repo"]);
});

test("ClientWorkspaceOrigins matches directories by path and worktrees by project, once each", () => {
  const origins = new ClientWorkspaceOrigins(() => 0, 1000);
  origins.record({ source: { kind: "directory", path: "/r/a/" } });
  origins.record({ source: { kind: "worktree", projectId: "p1" } });
  origins.record({
    source: { kind: "directory", path: "/r/lead" },
    agent: { config: { provider: "claude" }, labels: { "slp.role": "lead" } },
  });

  expect(origins.consume({ cwd: "/r/a", projectId: "pa" })).toBe(true);
  expect(origins.consume({ cwd: "/r/a", projectId: "pa" })).toBe(false);
  expect(origins.consume({ cwd: "/wt/y", projectId: "p2" })).toBe(false);
  expect(origins.consume({ cwd: "/wt/x", projectId: "p1" })).toBe(true);
  expect(origins.consume({ cwd: "/wt/x2", projectId: "p1" })).toBe(false);
  // A workspace created together with its own Lead needs no second Lead.
  expect(origins.consume({ cwd: "/r/lead", projectId: "pl" })).toBe(false);
});

test("ClientWorkspaceOrigins: a worktree request with unknown project matches the next workspace once", () => {
  const origins = new ClientWorkspaceOrigins(() => 0, 1000);
  origins.record({ source: { kind: "worktree", cwd: "/r/b" } });
  expect(origins.consume({ cwd: "/wt/z", projectId: "p3" })).toBe(true);
  expect(origins.consume({ cwd: "/wt/z2", projectId: "p3" })).toBe(false);
});

test("ClientWorkspaceOrigins forgets requests older than the TTL", () => {
  let now = 0;
  const origins = new ClientWorkspaceOrigins(() => now, 1000);
  origins.record({ source: { kind: "directory", path: "/r/late" } });
  now = 2000;
  expect(origins.consume({ cwd: "/r/late", projectId: "p" })).toBe(false);
});

function closedSupervisor(
  id: string,
  updatedAt: string,
  extra: Partial<AgentEntryLike["agent"]> = {},
) {
  return {
    agent: {
      id,
      provider: "claude",
      cwd: SUPERVISOR_DIR,
      status: "closed",
      workspaceId: "wks_sup",
      labels: { "slp.role": "supervisor" },
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt,
      ...extra,
    },
  };
}

test("ensureSupervisor resumes a closed Supervisor with a plugin notice instead of creating one", async () => {
  const host = fakeHost({
    workspaces: [supervisorWorkspace],
    agents: [closedSupervisor("S-closed", "2026-09-25T10:00:00.000Z")],
  });
  const deps = { supervisorDirectory: SUPERVISOR_DIR, makeDirectory: async () => {} };

  const first = await ensureSupervisor(host.api, deps);
  expect(first).toEqual({
    workspaceId: "wks_sup",
    agentId: "S-closed",
    created: false,
    resumed: true,
  });
  expect(host.created).toHaveLength(0);
  expect(host.createdWorkspaces).toHaveLength(0);
  expect(host.sent.map((s) => s.agentId)).toEqual(["S-closed"]);
  expect(host.sent[0]?.text).toContain("resumed by alp at startup");
  expect(host.sent[0]?.text).toContain("không phải Human");

  // Opening the app again finds it live: no second notice, no new Supervisor.
  const second = await ensureSupervisor(host.api, deps);
  expect(second).toEqual({ workspaceId: "wks_sup", agentId: "S-closed", created: false });
  expect(host.sent).toHaveLength(1);
  expect(host.created).toHaveLength(0);
});

test("ensureSupervisor resumes the newest closed Supervisor and skips archived ones", async () => {
  const host = fakeHost({
    workspaces: [supervisorWorkspace],
    agents: [
      closedSupervisor("S-old", "2026-09-20T10:00:00.000Z"),
      closedSupervisor("S-archived", "2026-09-25T12:00:00.000Z", { archivedAt: "2026-09-25" }),
      closedSupervisor("S-new", "2026-09-25T09:00:00.000Z"),
    ],
  });
  const deps = { supervisorDirectory: SUPERVISOR_DIR, makeDirectory: async () => {} };
  expect(await ensureSupervisor(host.api, deps)).toMatchObject({
    agentId: "S-new",
    resumed: true,
  });
  expect(host.sent.map((s) => s.agentId)).toEqual(["S-new"]);
  expect(host.created).toHaveLength(0);
});

test("ensureSupervisor creates a new Supervisor when the closed one cannot resume", async () => {
  const host = fakeHost({
    workspaces: [supervisorWorkspace],
    agents: [closedSupervisor("S-broken", "2026-09-25T10:00:00.000Z")],
  });
  host.failResume.add("S-broken");
  const deps = { supervisorDirectory: SUPERVISOR_DIR, makeDirectory: async () => {} };
  const result = await ensureSupervisor(host.api, deps);
  expect(result).toEqual({ workspaceId: "wks_sup", agentId: "agent1", created: true });
  expect(host.createdWorkspaces).toHaveLength(0);
});

test("ensureLead and ensureSupervisor create seats on the plain claude provider by label", async () => {
  const host = fakeHost({ workspaces: [repo] });
  await ensureLead(host.api, "wks_repo", { supervisorDirectory: SUPERVISOR_DIR });
  await ensureSupervisor(host.api, {
    supervisorDirectory: SUPERVISOR_DIR,
    makeDirectory: async () => {},
  });
  expect(host.created.map((c) => c.options)).toEqual([
    {
      config: { provider: "claude/claude-opus-5-5", modeId: "bypassPermissions" },
      title: "Lead",
      labels: { "slp.role": "lead" },
    },
    {
      config: { provider: "claude/claude-opus-5-5", modeId: "bypassPermissions" },
      title: "Supervisor",
      labels: { "slp.role": "supervisor" },
    },
  ]);
});

test("a workspace created together with a labeled Lead gets no second Lead", () => {
  const origins = new ClientWorkspaceOrigins(() => 0, 1000);
  origins.record({
    source: { kind: "directory", path: "/r/with-lead" },
    agent: { config: { provider: "claude" }, labels: { "slp.role": "lead" } },
  });
  origins.record({
    source: { kind: "directory", path: "/r/old-profile" },
    agent: { config: { provider: "claude-lead" } },
  });
  expect(origins.consume({ cwd: "/r/with-lead", projectId: "p" })).toBe(false);
  expect(origins.consume({ cwd: "/r/old-profile", projectId: "p" })).toBe(true);
});

test("a codex family creates Lead and Supervisor on the plain codex provider in full-access", async () => {
  const host = fakeHost({ workspaces: [repo] });
  await ensureLead(host.api, "wks_repo", { supervisorDirectory: SUPERVISOR_DIR, family: "codex" });
  await ensureSupervisor(host.api, {
    supervisorDirectory: SUPERVISOR_DIR,
    makeDirectory: async () => {},
    family: "codex",
  });
  expect(host.created.map((c) => c.options.config)).toEqual([
    { provider: "codex/claude-opus-5-5", modeId: "full-access" },
    { provider: "codex/claude-opus-5-5", modeId: "full-access" },
  ]);
});

const repoAgain: WorkspaceLike = {
  id: "wks_repo2",
  projectRootPath: "/r/app",
  workspaceDirectory: "/r/app",
};

function leadIn(
  workspaceId: string,
  overrides: Partial<AgentEntryLike["agent"]> = {},
): AgentEntryLike {
  return {
    agent: {
      id: `L-${workspaceId}`,
      provider: "claude",
      cwd: "/r/app",
      status: "idle",
      workspaceId,
      labels: { "slp.role": "lead" },
      ...overrides,
    },
  };
}

async function secondClientWorkspace(host: FakeHost, cwd = "/r/app") {
  const origins = new ClientWorkspaceOrigins();
  origins.record({ source: { kind: "directory", path: cwd } });
  return handleWorkspaceCreated(
    host.api,
    origins,
    { id: "wks_repo2", projectId: "p1", cwd },
    { supervisorDirectory: SUPERVISOR_DIR },
  );
}

test("workspace.created makes no second Lead for a directory whose live Lead is in another workspace", async () => {
  const host = fakeHost({ workspaces: [repo, repoAgain], agents: [leadIn("wks_repo")] });
  const result = await secondClientWorkspace(host, "/r/app/");
  expect(result).toEqual({ agentId: "L-wks_repo", created: false });
  expect(host.created).toHaveLength(0);
});

test("workspace.created still makes a Lead when the directory's other Lead is closed, archived, or its workspace is archiving", async () => {
  const cases: Array<{ workspaces: WorkspaceLike[]; agents: AgentEntryLike[] }> = [
    { workspaces: [repo, repoAgain], agents: [leadIn("wks_repo", { status: "closed" })] },
    { workspaces: [repo, repoAgain], agents: [leadIn("wks_repo", { archivedAt: "2026-09-01" })] },
    {
      workspaces: [{ ...repo, archivingAt: "2026-09-25T00:00:00.000Z" }, repoAgain],
      agents: [leadIn("wks_repo")],
    },
    // A live agent in the directory that is not in the Lead seat does not count.
    {
      workspaces: [repo, repoAgain],
      agents: [leadIn("wks_repo", { labels: { "slp.role": "peer" } })],
    },
  ];
  for (const initial of cases) {
    const host = fakeHost(initial);
    const result = await secondClientWorkspace(host);
    expect(result?.created).toBe(true);
    expect(host.created.map((c) => c.workspaceId)).toEqual(["wks_repo2"]);
  }
});

test("workspace.created makes a Lead for a directory whose only live Lead is elsewhere", async () => {
  const other: WorkspaceLike = { id: "wks_b", projectRootPath: "/r/b", workspaceDirectory: "/r/b" };
  const host = fakeHost({
    workspaces: [other, repoAgain],
    agents: [leadIn("wks_b", { cwd: "/r/b" })],
  });
  const result = await secondClientWorkspace(host);
  expect(result?.created).toBe(true);
  expect(host.created.map((c) => c.workspaceId)).toEqual(["wks_repo2"]);
});

test("slp.lead.ensure still gives a second workspace in the same directory its own Lead", async () => {
  const host = fakeHost({ workspaces: [repo, repoAgain], agents: [leadIn("wks_repo")] });
  const result = await ensureLead(host.api, "wks_repo2", { supervisorDirectory: SUPERVISOR_DIR });
  expect(result.created).toBe(true);
  expect(host.created.map((c) => c.workspaceId)).toEqual(["wks_repo2"]);
});

test("ensureLead rejects with an SLP disabled message when the switch is off, without creating anything", async () => {
  const host = fakeHost({ workspaces: [repo] });
  await expect(
    ensureLead(host.api, "wks_repo", { supervisorDirectory: SUPERVISOR_DIR }, false),
  ).rejects.toThrow(/SLP disabled/);
  expect(host.created).toHaveLength(0);
});

test("ensureSupervisor rejects with an SLP disabled message when the switch is off, without creating anything", async () => {
  const host = fakeHost({ workspaces: [repo] });
  const deps = { supervisorDirectory: SUPERVISOR_DIR, makeDirectory: async () => {} };
  await expect(ensureSupervisor(host.api, deps, false)).rejects.toThrow(/SLP disabled/);
  expect(host.created).toHaveLength(0);
});

test("handleWorkspaceCreated ensures no Lead when the switch is off, even for a matched client workspace", async () => {
  const host = fakeHost({ workspaces: [repo] });
  const origins = new ClientWorkspaceOrigins();
  origins.record({ source: { kind: "directory", path: "/r/app" } });
  const result = await handleWorkspaceCreated(
    host.api,
    origins,
    { id: "wks_repo", projectId: "p1", cwd: "/r/app" },
    { supervisorDirectory: SUPERVISOR_DIR },
    false,
  );
  expect(result).toBeNull();
  expect(host.created).toHaveLength(0);
});

test("workspace.created makes one Lead when two workspaces in a directory are created back to back", async () => {
  const host = fakeHost({ workspaces: [repo, repoAgain] });
  const origins = new ClientWorkspaceOrigins();
  origins.record({ source: { kind: "directory", path: "/r/app" } });
  origins.record({ source: { kind: "directory", path: "/r/app" } });
  const deps = { supervisorDirectory: SUPERVISOR_DIR };
  const [first, second] = await Promise.all([
    handleWorkspaceCreated(
      host.api,
      origins,
      { id: "wks_repo", projectId: "p1", cwd: "/r/app" },
      deps,
    ),
    handleWorkspaceCreated(
      host.api,
      origins,
      { id: "wks_repo2", projectId: "p1", cwd: "/r/app" },
      deps,
    ),
  ]);
  expect(host.created.map((c) => c.workspaceId)).toEqual(["wks_repo"]);
  expect(first?.created).toBe(true);
  expect(second).toEqual({ agentId: first?.agentId, created: false });
});
