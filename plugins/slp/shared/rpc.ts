import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** One Supervisor per host, in the `SLP Supervisor` workspace at `$PASEO_HOME/supervisor`. */
export const slpSupervisorEnsure = defineRpc({
  name: "slp.supervisor.ensure",
  input: z.object({}),
  output: z.object({ workspaceId: z.string(), agentId: z.string(), created: z.boolean() }),
});

/** The workspace has one live Lead (label `slp.role=lead`); created when missing. */
export const slpLeadEnsure = defineRpc({
  name: "slp.lead.ensure",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({ agentId: z.string(), created: z.boolean() }),
});
