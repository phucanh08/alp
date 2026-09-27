import type { PluginServerContext } from "@alp/plugin/server";
import { mkdir } from "node:fs/promises";
import {
  ClientWorkspaceOrigins,
  ensureLead,
  ensureSupervisor,
  handleWorkspaceCreated,
  projectOfCheckout,
} from "./server/ensure";
import { allowAlpTools, createLeadAnnouncer, withSeatConfig } from "./server/hooks";
import { supervisorDirectory } from "./server/paths";
import { familyOf } from "./server/seat";
import { createSeatSkills, seatSkillsRoot } from "./server/seat-skills";
import { isEnabled, supervisorCheckMinutes, supervisorModel } from "./server/settings";
import {
  createSupervisorCheck,
  SUPERVISOR_CHECK_TICK_MS,
  type SupervisorCheckHost,
} from "./server/supervisor-check";
import { slpLeadEnsure, slpSupervisorEnsure } from "./shared/rpc";
import { slpSettings } from "./shared/settings";

/**
 * slp: SLP seats (Supervisor / Lead / Peer) on alp. See README.md for behavior and boundaries.
 * `enabled` (ruling p11 G1) is the SLP switch: every hook and RPC below reads it itself before
 * doing anything, so `false` makes the plugin inert — it does not seat, label, ensure, announce, or
 * auto-allow permissions, and every request passes through unchanged.
 * The Supervisor check (`server/supervisor-check.ts`) ticks every minute on the Alp API the last
 * hook received — the plugin process has one API, and `contribute` gets none — and reads
 * `supervisorCheckMinutes` each tick, so a changed setting applies without a restart.
 * Seat skill directories (`server/seat-skills.ts`) need slp-dev, so they cannot be written at
 * start: every seat is brought up to date on the first Claude/Codex session open (the resume of a
 * stored agent, which re-sends its stored plugin path or extra root), and a seat's own directory
 * again right before each Lead or Peer is created.
 */
export default function contribute(server: PluginServerContext) {
  const supervisorDir = supervisorDirectory();
  const origins = new ClientWorkspaceOrigins();
  const settings = server.registerSettings(slpSettings);
  const enabled = async () => isEnabled(await settings.read());
  const announceLeads = createLeadAnnouncer();
  const supervisorCheck = createSupervisorCheck();
  const skillsRoot = seatSkillsRoot();
  if (!skillsRoot) console.warn("slp: ALP_HOME is not set; seats get no skill directory");
  const seatSkills = createSeatSkills(skillsRoot);
  let seatSkillsRefreshed = false;
  let checkHost: SupervisorCheckHost | null = null;
  const checkTimer = setInterval(() => {
    const host = checkHost;
    if (!host) return;
    void (async () => {
      const minutes = supervisorCheckMinutes(await settings.read());
      await supervisorCheck.tick(host, minutes, Date.now());
    })().catch((error) => console.error(`slp: supervisor check failed: ${String(error)}`));
  }, SUPERVISOR_CHECK_TICK_MS);

  server.handle(slpSupervisorEnsure, async (_input, { alp }) => {
    const state = await settings.read();
    return ensureSupervisor(
      alp,
      {
        supervisorDirectory: supervisorDir,
        makeDirectory: (directory) => mkdir(directory, { recursive: true }),
        supervisorModel: supervisorModel(state),
      },
      isEnabled(state),
    );
  });
  server.handle(slpLeadEnsure, async ({ workspaceId }, { alp }) =>
    ensureLead(alp, workspaceId, { supervisorDirectory: supervisorDir }, await enabled()),
  );

  const removers = [
    server.before("agent.create", async ({ request }, { alp }) =>
      withSeatConfig(
        request,
        {
          agents: alp.agents,
          plugins: alp.plugins,
          seatSkills: (seat) => seatSkills.ensure(seat, alp.plugins),
        },
        await enabled(),
      ),
    ),
    server.before("agent.session_open", async ({ request }, { alp }) => {
      if (seatSkillsRefreshed || !familyOf(request.provider) || !(await enabled()))
        return undefined;
      seatSkillsRefreshed = true;
      await seatSkills.ensureAll(alp.plugins);
      return undefined;
    }),
    server.before("workspace.create", async ({ request }, { alp }) => {
      // Record only; never change or fail the user's request.
      try {
        const { source } = request;
        const projectId =
          source.kind === "worktree" && !source.projectId && source.cwd
            ? await projectOfCheckout(alp, source.cwd)
            : null;
        origins.record(
          projectId && source.kind === "worktree"
            ? { ...request, source: { ...source, projectId } }
            : request,
        );
      } catch (error) {
        console.error(`slp: could not record workspace request: ${String(error)}`);
      }
      return undefined;
    }),
    server.on("workspace.created", async ({ workspace }, { alp }) => {
      try {
        const result = await handleWorkspaceCreated(
          alp,
          origins,
          workspace,
          { supervisorDirectory: supervisorDir },
          await enabled(),
        );
        if (result)
          console.log(
            `slp: workspace ${workspace.id} lead ${result.agentId} (created ${result.created})`,
          );
      } catch (error) {
        console.error(
          `slp: could not ensure a Lead for workspace ${workspace.id}: ${String(error)}`,
        );
      }
    }),
    server.on("agent.turn_started", async (event, { alp }) => {
      checkHost = alp;
      if (!(await enabled())) return;
      supervisorCheck.turnStarted(event.agent.id);
    }),
    server.on("agent.turn_ended", async (event, context) => {
      checkHost = context.alp;
      if (!(await enabled())) return;
      try {
        await supervisorCheck.turnEnded(context.alp, event.agent, event.timeline);
      } catch (error) {
        console.error(`slp: could not read lead ${event.agent.id} reports: ${String(error)}`);
      }
      await announceLeads(event, context);
    }),
    server.on("agent.permission_requested", async (event, context) => {
      checkHost = context.alp;
      if (!(await enabled())) return;
      await allowAlpTools(event, context);
    }),
  ];

  return () => {
    clearInterval(checkTimer);
    for (const remove of removers) remove();
  };
}
