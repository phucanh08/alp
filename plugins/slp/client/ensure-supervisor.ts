import type { SupervisorTarget } from "./supervisor-rpc";

type EnsureSupervisor = () => Promise<SupervisorTarget>;

/**
 * Creates the Supervisor as soon as the client plugin loads on a host. A failure is logged and
 * swallowed: the app keeps working, and the sidebar item retries when the user opens it.
 */
export async function ensureSupervisorOnLoad(input: {
  ensure: EnsureSupervisor;
  warn: (message: string, error: unknown) => void;
}): Promise<SupervisorTarget | null> {
  try {
    return await input.ensure();
  } catch (error) {
    input.warn("[slp] Supervisor ensure failed", error);
    return null;
  }
}

/** Ensures the Supervisor exists, then opens its agent. Failures reach the caller. */
export async function openSupervisor(input: {
  ensure: EnsureSupervisor;
  openAgent: (target: { agentId: string }) => void;
}): Promise<SupervisorTarget> {
  const target = await input.ensure();
  input.openAgent({ agentId: target.agentId });
  return target;
}
