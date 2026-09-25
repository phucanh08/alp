import type { Agent } from "@/stores/session-store";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

// ALP(slp): the bundled slp plugin labels its Supervisor agent `slp.role=supervisor` and runs it in
// a system workspace under $PASEO_HOME/supervisor. The label is the only seam the app reads.
export const SLP_ROLE_LABEL = "slp.role";
export const SLP_SUPERVISOR_ROLE = "supervisor";

export type SlpSystemAgentFields = Pick<Agent, "workspaceId" | "labels" | "archivedAt">;

/**
 * Workspace ids that belong to SLP itself rather than to the user: every workspace with at least
 * one non-archived Supervisor agent. Lists hide these; the store keeps them so the Supervisor
 * button can still navigate there.
 */
export function collectSlpSystemWorkspaceIds(
  agents: Iterable<SlpSystemAgentFields>,
): ReadonlySet<string> {
  const workspaceIds = new Set<string>();
  for (const agent of agents) {
    if (agent.archivedAt || agent.labels[SLP_ROLE_LABEL] !== SLP_SUPERVISOR_ROLE) continue;
    const workspaceId = normalizeWorkspaceOpaqueId(agent.workspaceId);
    if (workspaceId) workspaceIds.add(workspaceId);
  }
  return workspaceIds;
}
