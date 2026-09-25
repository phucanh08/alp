import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Wire contract owned by the slp server entry. Keep the name and shapes in step with it.
export const ensureSupervisorRpc = defineRpc({
  name: "slp.supervisor.ensure",
  input: z.object({}),
  output: z.object({
    workspaceId: z.string(),
    agentId: z.string(),
    created: z.boolean(),
  }),
});

export interface SupervisorTarget {
  readonly workspaceId: string;
  readonly agentId: string;
  readonly created: boolean;
}
