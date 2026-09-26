import type { PluginServerContext } from "@getpaseo/plugin/server";
import { mkdir } from "node:fs/promises";
import {
  ClientWorkspaceOrigins,
  ensureLead,
  ensureSupervisor,
  handleWorkspaceCreated,
  projectOfCheckout,
} from "./server/ensure";
import { allowPaseoTools, createLeadAnnouncer, withSeatConfig } from "./server/hooks";
import { supervisorDirectory } from "./server/paths";
import { isEnabled } from "./server/settings";
import { slpLeadEnsure, slpSupervisorEnsure } from "./shared/rpc";
import { slpSettings } from "./shared/settings";

/**
 * slp: SLP seats (Supervisor / Lead / Peer) on alp. See README.md for behavior and boundaries.
 */
export default function contribute(server: PluginServerContext) {
  const supervisorDir = supervisorDirectory();
  const origins = new ClientWorkspaceOrigins();
  const settings = server.registerSettings(slpSettings);
  const enabled = async () => isEnabled(await settings.read());

  server.handle(slpSupervisorEnsure, async (_input, { paseo }) =>
    ensureSupervisor(
      paseo,
      {
        supervisorDirectory: supervisorDir,
        makeDirectory: (directory) => mkdir(directory, { recursive: true }),
      },
      await enabled(),
    ),
  );
  server.handle(slpLeadEnsure, async ({ workspaceId }, { paseo }) =>
    ensureLead(paseo, workspaceId, { supervisorDirectory: supervisorDir }, await enabled()),
  );

  const removers = [
    server.before("agent.create", async ({ request }, { paseo }) =>
      withSeatConfig(request, paseo.agents, await enabled()),
    ),
    server.before("workspace.create", async ({ request }, { paseo }) => {
      // Record only; never change or fail the user's request.
      try {
        const { source } = request;
        const projectId =
          source.kind === "worktree" && !source.projectId && source.cwd
            ? await projectOfCheckout(paseo, source.cwd)
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
    server.on("workspace.created", async ({ workspace }, { paseo }) => {
      try {
        const result = await handleWorkspaceCreated(
          paseo,
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
    server.on("agent.turn_ended", createLeadAnnouncer()),
    server.on("agent.permission_requested", allowPaseoTools),
  ];

  return () => {
    for (const remove of removers) remove();
  };
}
