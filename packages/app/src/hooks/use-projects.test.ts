import equal from "fast-deep-equal";
import { describe, expect, it } from "vitest";
import type { SlpSystemAgentFields } from "@/slp/system-workspaces";
import type { ProjectDescriptor, WorkspaceDescriptor } from "@/stores/session-store";
import {
  deriveProjectsFromReplica,
  selectProjectHostReplicas,
  type ProjectHostReplica,
  type ProjectHostRuntimeState,
} from "@/hooks/use-projects";

function project(id: string, name: string, root: string): ProjectDescriptor {
  return {
    projectId: id,
    projectKey: `remote:github.com/${name}`,
    projectDisplayName: name,
    projectCustomName: null,
    projectRootPath: root,
    projectKind: "git",
  };
}

function workspace(id: string, projectId: string, root: string): WorkspaceDescriptor {
  return {
    id,
    projectId,
    projectDisplayName: projectId,
    projectCustomName: null,
    projectRootPath: root,
    workspaceDirectory: root,
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "main",
    status: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  };
}

function runtimeState(input: Partial<ProjectHostRuntimeState> & { serverId: string }) {
  return {
    serverId: input.serverId,
    isOnline: input.isOnline ?? true,
    isLoading: input.isLoading ?? false,
    isFetching: input.isFetching ?? false,
    error: input.error ?? null,
  };
}

describe("deriveProjectsFromReplica", () => {
  it("derives projects from the project descriptor replica", () => {
    const replicas: ProjectHostReplica[] = [
      {
        serverId: "local",
        serverName: "Local",
        workspaces: [],
        projects: [project("prj_zeta", "acme/zeta", "/repo/zeta")],
      },
      {
        serverId: "laptop",
        serverName: "Laptop",
        workspaces: [],
        projects: [project("prj_alpha", "acme/alpha", "/repo/alpha")],
      },
    ];

    const result = deriveProjectsFromReplica({
      replicas,
      runtimeStates: [
        runtimeState({ serverId: "local" }),
        runtimeState({ serverId: "laptop", isOnline: false }),
      ],
    });

    expect(result.projects.map((item) => item.projectName)).toEqual(["acme/alpha", "acme/zeta"]);
    expect(result.projects[0]?.hosts[0]).toMatchObject({
      serverId: "laptop",
      projectId: "prj_alpha",
      repoRoot: "/repo/alpha",
      workspaceCount: 0,
    });
  });

  it("preserves runtime loading and error state", () => {
    const result = deriveProjectsFromReplica({
      replicas: [
        {
          serverId: "local",
          serverName: "Local",
          workspaces: [],
          projects: [project("prj_app", "acme/app", "/repo/app")],
        },
      ],
      runtimeStates: [
        runtimeState({
          serverId: "local",
          isLoading: true,
          isFetching: true,
          error: "unavailable",
        }),
      ],
    });

    expect(result.isLoading).toBe(true);
    expect(result.isFetching).toBe(true);
    expect(result.hostErrors).toEqual([
      { serverId: "local", serverName: "Local", message: "unavailable" },
    ]);
  });

  it("leaves out the project that runs a live SLP Supervisor", () => {
    const agents = new Map<string, SlpSystemAgentFields>([
      [
        "agent-supervisor",
        { workspaceId: "ws_sup", labels: { "slp.role": "supervisor" }, archivedAt: null },
      ],
    ]);
    const session = {
      workspaces: new Map([
        ["ws_app", workspace("ws_app", "prj_app", "/repo/app")],
        ["ws_sup", workspace("ws_sup", "prj_sup", "/home/.alp/supervisor")],
      ]),
      projects: new Map([
        ["prj_app", project("prj_app", "acme/app", "/repo/app")],
        ["prj_sup", project("prj_sup", "supervisor", "/home/.alp/supervisor")],
      ]),
      agents,
    };
    const select = selectProjectHostReplicas([{ serverId: "local", label: "Local" }], true);

    const replicas = select({ sessions: { local: session } });
    const result = deriveProjectsFromReplica({
      replicas,
      runtimeStates: [runtimeState({ serverId: "local" })],
    });

    expect(result.projects.map((item) => item.projectName)).toEqual(["acme/app"]);
    expect(result.projects[0]?.totalWorkspaceCount).toBe(1);

    const unrelatedAgentUpdate = new Map(agents);
    unrelatedAgentUpdate.set("agent-app", { workspaceId: "ws_app", labels: {}, archivedAt: null });
    const nextReplicas = select({
      sessions: { local: { ...session, agents: unrelatedAgentUpdate } },
    });
    expect(equal(nextReplicas, replicas)).toBe(true);

    const supervisorArchived = new Map<string, SlpSystemAgentFields>([
      [
        "agent-supervisor",
        {
          workspaceId: "ws_sup",
          labels: { "slp.role": "supervisor" },
          archivedAt: new Date("2026-09-01"),
        },
      ],
    ]);
    const archivedReplicas = select({
      sessions: { local: { ...session, agents: supervisorArchived } },
    });
    expect(equal(archivedReplicas, replicas)).toBe(false);
  });
});
