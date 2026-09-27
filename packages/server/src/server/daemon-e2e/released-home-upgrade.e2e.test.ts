// alp-rename-keep-file: the fixture is a machine alp 1.0.0 left behind, under its pre-rename names.
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { getParentAgentIdFromLabels } from "@alp/protocol/agent-labels";

import { resolveAlpHome } from "../alp-home.js";
import { applyResolvedAlpHomeEnv } from "../alp-env.js";
import { createAlpDaemon, formatListenTarget } from "../bootstrap.js";
import { loadConfig } from "../config.js";
import { daemonLaunchEnvironment } from "../config-environment.js";
import { resolveSkillTargets } from "../orchestration-skills/internal/paths.js";
import { acquirePidLock, getPidLockInfo, releasePidLock, updatePidLock } from "../pid-lock.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import {
  logPreRenameMigration,
  migratePreRenameState,
  type PreRenameMigrationReport,
} from "../rename-migration/home-state.js";
import { setLegacyNameReporter } from "../rename-migration/legacy-names.js";

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const CLI_ENTRY = path.join(REPOSITORY_ROOT, "packages", "cli", "src", "index.ts");
const TIMESTAMP = "2026-09-20T00:00:00.000Z";
const SKILL_HOMES = [".agents", ".claude", ".codex"] as const;

// Upgrade proof for a machine alp 1.0.0 ran on: its home, found through PASEO_HOME alone, and its
// agent skill homes, repo config, and plugin, all under the pre-rename names. The daemon starts the
// way daemon-worker.ts starts it — the supervisor takes the lock, then home, migration, config —
// but in process, with fake providers, so the client and the CLI can look at what it serves.

interface Fixture {
  root: string;
  userHome: string;
  alpHome: string;
  repo: string;
  worktree: string;
  pluginDir: string;
  envDump: string;
}

interface LogRecord {
  level: number;
  msg: string;
  [key: string]: unknown;
}

interface StartedDaemon {
  daemon: Awaited<ReturnType<typeof createAlpDaemon>>;
  client: DaemonClient;
  migration: PreRenameMigrationReport;
  logs: LogRecord[];
  stop: () => Promise<void>;
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv): void {
  execFileSync("git", ["-c", "user.name=alp", "-c", "user.email=alp@example.invalid", ...args], {
    cwd,
    env,
    stdio: "ignore",
  });
}

function listFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(dir);
  return files;
}

/** Every file under `dir` with its bytes, keyed by path relative to `dir`. */
function snapshot(dir: string, skip: (relative: string) => boolean): Record<string, string> {
  const files: Record<string, string> = {};
  for (const file of listFiles(dir)) {
    const relative = path.relative(dir, file);
    if (skip(relative)) continue;
    files[relative] = createHash("sha256").update(readFileSync(file)).digest("hex");
  }
  return files;
}

/** A skill directory as 1.0.0 installed it: the bundled files and its `.paseo-managed-files.json`. */
function installReleasedSkill(sourceDir: string, targetDir: string): void {
  cpSync(sourceDir, targetDir, { recursive: true });
  const files: Record<string, string> = {};
  for (const file of listFiles(targetDir)) {
    files[path.relative(targetDir, file).split(path.sep).join("/")] = createHash("sha256")
      .update(readFileSync(file))
      .digest("hex");
  }
  writeJson(path.join(targetDir, ".paseo-managed-files.json"), { version: 1, files });
}

function buildReleasedMachine(gitEnv: NodeJS.ProcessEnv, fixture: Fixture): void {
  const { alpHome, userHome, repo, worktree, pluginDir, envDump } = fixture;
  mkdirSync(alpHome, { recursive: true });

  // The 1.0.0 supervisor's lock, left behind by a daemon that died before this boot.
  writeFileSync(
    path.join(alpHome, "paseo.pid"),
    JSON.stringify({
      pid: process.pid,
      startedAt: "2000-01-01T00:00:00.000Z",
      hostname: "released-host",
      uid: 0,
      listen: "127.0.0.1:6767",
      heartbeat: true,
    }),
  );

  // A repo with its 1.0.0 paseo.json, and a worktree the daemon made for it.
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"], gitEnv);
  writeFileSync(path.join(repo, "README.md"), "released\n");
  git(repo, ["add", "README.md"], gitEnv);
  git(repo, ["commit", "-q", "-m", "init"], gitEnv);
  git(repo, ["worktree", "add", "-q", "-b", "feature", worktree], gitEnv);
  writeJson(
    path.join(repo, ".git", "worktrees", path.basename(worktree), "paseo", "worktree.json"),
    {
      version: 1,
      baseRefName: "main",
    },
  );
  const dumpScript = path.join(fixture.root, "dump-env.cjs");
  writeFileSync(
    dumpScript,
    'require("node:fs").writeFileSync(process.argv[2], JSON.stringify(process.env));\n',
  );
  writeJson(path.join(repo, "paseo.json"), {
    scripts: {
      "dump-env": {
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(dumpScript)} ${JSON.stringify(envDump)}`,
      },
    },
  });

  // A plugin written for upstream Paseo, installed from a directory.
  mkdirSync(pluginDir, { recursive: true });
  writeJson(path.join(pluginDir, "paseo-plugin.json"), {
    id: "released-plugin",
    requirements: { paseo: ">=0.9.1 <0.10.0" },
  });
  writeFileSync(
    path.join(pluginDir, "index.server.ts"),
    `import { defineRpc } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";

const ping = defineRpc({ name: "ping", input: z.object({}), output: z.object({ pong: z.string() }) });

export default function contribute(server: PluginServerContext) {
  server.handle(ping, async () => ({ pong: "released" }));
  return () => undefined;
}
`,
  );
  writeFileSync(
    path.join(pluginDir, "index.client.tsx"),
    `import type { PluginClientContext } from "@getpaseo/plugin/client";
export default function contribute(client: PluginClientContext) { return () => void client; }
`,
  );

  writeJson(path.join(alpHome, "config.json"), {
    version: 1,
    pluginsEnabled: true,
    plugins: { "released-plugin": { source: "directory", path: pluginDir, enabled: true } },
    agents: { providers: { claude: { paseoTools: { disabledTools: ["archive_agent"] } } } },
  });

  writeJson(path.join(alpHome, "projects", "projects.json"), [
    {
      projectId: "prj_released",
      rootPath: repo,
      kind: "git",
      displayName: "repo",
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      archivedAt: null,
    },
  ]);
  writeJson(path.join(alpHome, "projects", "workspaces.json"), [
    {
      workspaceId: "wks_released_main",
      projectId: "prj_released",
      cwd: repo,
      kind: "local_checkout",
      displayName: "main",
      worktreeRoot: repo,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      archivedAt: null,
    },
    {
      workspaceId: "wks_released_feature",
      projectId: "prj_released",
      cwd: worktree,
      kind: "worktree",
      displayName: "feature",
      branch: "feature",
      worktreeRoot: worktree,
      isPaseoOwnedWorktree: true,
      mainRepoRoot: repo,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      archivedAt: null,
    },
  ]);

  const agent = (id: string, labels: Record<string, string>) => ({
    id,
    provider: "claude",
    cwd: repo,
    workspaceId: "wks_released_main",
    title: id,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    labels,
    lastStatus: "closed",
  });
  writeJson(
    path.join(alpHome, "agents", "released-project", "lead-agent.json"),
    agent("lead-agent", { "paseo.schedule-id": "sched-1" }),
  );
  writeJson(
    path.join(alpHome, "agents", "released-project", "peer-agent.json"),
    agent("peer-agent", { "paseo.parent-agent-id": "lead-agent", "slp.role": "peer" }),
  );

  // alp-help as 1.0.0 installed it in each of the three agent skill homes.
  const { sourceDir } = resolveSkillTargets(userHome);
  for (const skillHome of SKILL_HOMES) {
    installReleasedSkill(
      path.join(sourceDir, "alp-help"),
      path.join(userHome, skillHome, "skills", "alp-help"),
    );
  }
}

/**
 * daemon-worker.ts's start, in process. The supervisor takes the lock before the worker runs,
 * the worker migrates before it reads config, and the supervisor publishes the listen address.
 */
async function startDaemonLikeWorker(afterMigration?: () => void): Promise<StartedDaemon> {
  const alpHome = resolveAlpHome();
  // Same as daemon-worker.ts's bootstrapFromEnvironment: publish the resolved home into
  // process.env before anything forks, so a PASEO_HOME-only environment still hands ALP_HOME to
  // children that inherit process.env outright (the plugin host).
  applyResolvedAlpHomeEnv(alpHome);
  await acquirePidLock(alpHome, null, { ownerPid: process.pid });
  const migration = migratePreRenameState({ alpHome });
  afterMigration?.();
  const config = loadConfig(alpHome);
  const logs: LogRecord[] = [];
  const logger = pino(
    { level: "info" },
    {
      write(line: string) {
        logs.push(JSON.parse(line) as LogRecord);
      },
    },
  );
  setLegacyNameReporter((use) =>
    logger.warn(
      { ...use },
      `Read ${use.legacy} from before the alp rename; rename it to ${use.current}`,
    ),
  );
  logPreRenameMigration(logger, migration);

  const staticDir = mkdtempSync(path.join(tmpdir(), "alp-upgrade-static-"));
  const daemon = await createAlpDaemon(
    {
      ...config,
      listen: "127.0.0.1:0",
      staticDir,
      agentClients: createTestAgentClients(),
      relayEnabled: false,
      mcpEnabled: false,
    },
    logger,
  );
  await daemon.start();
  const listen = formatListenTarget(daemon.getListenTarget());
  if (!listen) throw new Error("daemon did not publish a listen target");
  await updatePidLock(
    alpHome,
    { listen, serverId: daemon.getServerId() },
    { ownerPid: process.pid },
  );

  const target = daemon.getListenTarget();
  if (target?.type !== "tcp") throw new Error("daemon is not listening on TCP");
  const client = new DaemonClient({ url: `ws://127.0.0.1:${target.port}/ws`, appVersion: "1.0.0" });
  await client.connect();

  return {
    daemon,
    client,
    migration,
    logs,
    stop: async () => {
      await client.close().catch(() => undefined);
      await daemon.stop().catch(() => undefined);
      await daemon.agentManager.flush().catch(() => undefined);
      await releasePidLock(alpHome, { ownerPid: process.pid });
      rmSync(staticDir, { recursive: true, force: true });
    },
  };
}

// The worker's environment on the released machine: PASEO_HOME set, ALP_HOME never set.
const SCRUBBED_ENV_PREFIXES = ["ALP_", "PASEO_"];
const KEPT_TEST_ENV = new Set(["ALP_SUPERVISED", "ALP_GIT_MAX_PROCESSES_PER_SECOND"]);

async function runCli(args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--conditions=source", "--import", "tsx", CLI_ENTRY, ...args, "--json"],
    { cwd: REPOSITORY_ROOT, env: { ...process.env, NO_COLOR: "1" }, timeout: 60_000 },
  );
  const parsed = JSON.parse(stdout) as unknown;
  return (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, unknown>;
}

function replaceProcessEnv(next: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in next)) delete process.env[key];
  }
  Object.assign(process.env, next);
}

describe.skipIf(process.platform === "win32")("a machine alp 1.0.0 ran on", () => {
  const savedEnv = { ...process.env };
  let fixture: Fixture;
  let running: StartedDaemon | null = null;

  beforeAll(() => {
    const root = mkdtempSync(path.join(tmpdir(), "alp-released-machine-"));
    const alpHome = path.join(root, "released-home");
    fixture = {
      root,
      userHome: path.join(root, "user"),
      alpHome,
      repo: path.join(root, "repo"),
      worktree: path.join(alpHome, "worktrees", "released0", "feature"),
      pluginDir: path.join(root, "released-plugin"),
      envDump: path.join(root, "script-env.json"),
    };
    mkdirSync(fixture.userHome, { recursive: true });
    for (const key of Object.keys(process.env)) {
      if (
        SCRUBBED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)) &&
        !KEPT_TEST_ENV.has(key)
      ) {
        delete process.env[key];
      }
    }
    process.env.HOME = fixture.userHome;
    process.env.USERPROFILE = fixture.userHome;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.PASEO_HOME = fixture.alpHome;
    buildReleasedMachine(process.env, fixture);
  });

  afterAll(async () => {
    await running?.stop();
    replaceProcessEnv(savedEnv);
    rmSync(fixture.root, { recursive: true, force: true });
  });

  test("the daemon starts on the released home and serves what 1.0.0 left", async () => {
    running = await startDaemonLikeWorker();
    const { client, logs, daemon } = running;

    // The home came from PASEO_HOME, and the lock is alp.pid.
    expect(daemon.config.alpHome).toBe(fixture.alpHome);
    expect(existsSync(path.join(fixture.alpHome, "paseo.pid"))).toBe(false);
    expect((await getPidLockInfo(fixture.alpHome))?.pid).toBe(process.pid);
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: 40,
        kind: "env",
        legacy: "PASEO_HOME",
        current: "ALP_HOME",
      }),
    );

    // Agents keep their labels under the alp names, and the peer still hangs off the lead.
    const agents = await client.fetchAgents();
    const byId = new Map(agents.entries.map((entry) => [entry.agent.id, entry.agent]));
    expect(byId.get("lead-agent")?.labels).toEqual({ "alp.schedule-id": "sched-1" });
    expect(byId.get("peer-agent")?.labels).toEqual({
      "alp.parent-agent-id": "lead-agent",
      "slp.role": "peer",
    });
    expect(getParentAgentIdFromLabels(byId.get("peer-agent")?.labels)).toBe("lead-agent");

    // The provider's tool policy and the owned worktree survive under their new keys.
    const { config } = await client.getDaemonConfig();
    expect(config.providers.claude?.alpTools).toEqual({ disabledTools: ["archive_agent"] });
    const workspaces = JSON.parse(
      readFileSync(path.join(fixture.alpHome, "projects", "workspaces.json"), "utf8"),
    ) as Array<Record<string, unknown>>;
    expect(
      workspaces.find((record) => record.workspaceId === "wks_released_feature"),
    ).toMatchObject({ isAlpOwnedWorktree: true });
    expect(JSON.stringify(workspaces)).not.toContain("isPaseoOwnedWorktree");
  }, 120_000);

  test("the repo's paseo.json runs its scripts, and the script sees both env names", async () => {
    const client = running!.client;
    const listed = await client.listWorkspaceScripts("wks_released_main");
    expect(listed.error).toBeNull();
    expect(listed.scripts?.map((script) => script.scriptName)).toEqual(["dump-env"]);
    expect(running!.logs).toContainEqual(
      expect.objectContaining({
        level: 40,
        kind: "repo-config",
        legacy: "paseo.json",
        current: "alp.json",
        path: path.join(fixture.repo, "paseo.json"),
      }),
    );

    const started = await client.startWorkspaceScriptWithStatus("wks_released_main", "dump-env");
    expect(started.error).toBeNull();
    const env = await vi.waitFor(
      () => JSON.parse(readFileSync(fixture.envDump, "utf8")) as Record<string, string>,
      { timeout: 30_000, interval: 200 },
    );
    // Every ALP_* name the daemon writes into the script's terminal has its 1.0.0 twin. The
    // zsh integration's own ALP_ZSH_ZDOTDIR is read only by the rc files the daemon writes.
    const written = Object.keys(env).filter(
      (name) => name.startsWith("ALP_") && !(name in process.env) && name !== "ALP_ZSH_ZDOTDIR",
    );
    expect(written).toEqual(
      expect.arrayContaining([
        "ALP_WORKSPACE_ID",
        "ALP_TERMINAL_ID",
        "ALP_ACTIVITY_TOKEN",
        "ALP_TERMINAL_ACTIVITY_URL",
      ]),
    );
    expect(env.ALP_WORKSPACE_ID).toBe("wks_released_main");
    for (const name of written) {
      expect(env[name.replace(/^ALP_/, "PASEO_")], name).toBe(env[name]);
    }
    expect(readdirSync(fixture.repo).sort()).toEqual([".git", "README.md", "paseo.json"]);
  }, 60_000);

  test("the upstream plugin loads and reaches the app as an alp plugin", async () => {
    const client = running!.client;
    const pong = await vi.waitFor(() => client.invokePluginRpc("released-plugin", "ping", {}), {
      timeout: 60_000,
      interval: 250,
    });
    expect(pong).toEqual({ pong: "released" });
    const catalog = await client.getPluginCatalog();
    expect(catalog.find((entry) => entry.id === "released-plugin")?.requirements).toEqual({
      alp: ">=1.0.0",
    });
  }, 90_000);

  test("installed skills keep their managed state", async () => {
    const { client } = running!;
    const status = await vi.waitFor(
      async () => {
        const next = await client.getAgentSkillsStatus();
        if (next.state !== "up-to-date") throw new Error(`skills are ${next.state}`);
        return next;
      },
      { timeout: 30_000, interval: 250 },
    );
    expect(status.installed).toContain("alp-help");
    for (const skillHome of SKILL_HOMES) {
      expect(readdirSync(path.join(fixture.userHome, skillHome, "skills", "alp-help"))).toEqual(
        expect.arrayContaining([".alp-managed-files.json", "SKILL.md"]),
      );
      expect(
        readdirSync(path.join(fixture.userHome, skillHome, "skills", "alp-help")),
      ).not.toContain(".paseo-managed-files.json");
    }
  }, 60_000);

  test("alp daemon status finds the daemon with only PASEO_HOME set", async () => {
    const status = await runCli(["daemon", "status"]);
    expect(status).toMatchObject({
      home: fixture.alpHome,
      localDaemon: "running",
      connectedDaemon: "reachable",
      serverId: running!.daemon.getServerId(),
    });
  }, 90_000);

  // The plugin host's fork() inherits process.env outright — it never re-resolves the home from a
  // different name. With only PASEO_HOME set, the daemon still has to publish ALP_HOME so slp
  // builds a seat's skill directory instead of logging that ALP_HOME is not set.
  test("slp builds a seat's skill directory under the home with only PASEO_HOME set", async () => {
    const { client, daemon } = running!;
    await vi.waitFor(
      () => client.invokePluginRpc("slp-dev", "slp-dev.seat.get", { seat: "peer" }),
      {
        timeout: 60_000,
        interval: 250,
      },
    );
    const peer = await client.createAgent({
      provider: "claude",
      cwd: fixture.repo,
      title: "Seated peer (PASEO_HOME only)",
      labels: { "slp.role": "peer" },
    });

    expect(daemon.agentManager.getAgent(peer.id)?.config.systemPrompt).toContain("# Ghế SLP: peer");
    const seatDir = path.join(fixture.alpHome, "slp", "seat-skills", "peer");
    expect(readdirSync(path.join(seatDir, "skills")).sort()).toEqual([
      "bug-loop",
      "smart-commits",
      "xia",
    ]);
    await client.archiveAgent(peer.id);
  }, 120_000);

  // `alp daemon start` resolves the home the same way and hands it to the daemon as ALP_HOME.
  test("restarted by alp daemon start, it migrates nothing and leaves the tree as it was", async () => {
    await running!.stop();
    running = null;
    replaceProcessEnv(
      daemonLaunchEnvironment({ env: process.env, home: resolveAlpHome(), mode: "managed" }),
    );
    const lock = (relative: string) => relative === path.join("released-home", "alp.pid");
    const before = snapshot(fixture.root, lock);
    let afterMigration: Record<string, string> = {};

    running = await startDaemonLikeWorker(() => {
      afterMigration = snapshot(fixture.root, lock);
    });

    expect(running.daemon.config.alpHome).toBe(fixture.alpHome);
    expect(running.migration).toEqual({ changed: [], skipped: [] });
    expect(afterMigration).toEqual(before);
    const agents = await running.client.fetchAgents();
    expect(agents.entries.map((entry) => entry.agent.id)).toEqual(
      expect.arrayContaining(["lead-agent", "peer-agent"]),
    );
  }, 120_000);

  test("slp builds a seat's skill directory under the home", async () => {
    const { client, daemon } = running!;
    await vi.waitFor(
      () => client.invokePluginRpc("slp-dev", "slp-dev.seat.get", { seat: "peer" }),
      {
        timeout: 60_000,
        interval: 250,
      },
    );
    const peer = await client.createAgent({
      provider: "claude",
      cwd: fixture.repo,
      title: "Seated peer",
      labels: { "slp.role": "peer" },
    });

    expect(daemon.agentManager.getAgent(peer.id)?.config.systemPrompt).toContain("# Ghế SLP: peer");
    const seatDir = path.join(fixture.alpHome, "slp", "seat-skills", "peer");
    expect(readdirSync(path.join(seatDir, "skills")).sort()).toEqual([
      "bug-loop",
      "smart-commits",
      "xia",
    ]);
    await client.archiveAgent(peer.id);
  }, 120_000);
});
