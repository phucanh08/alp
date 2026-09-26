import type {
  PluginBeforeRequests,
  PluginHookContext,
  PluginLifecycleEvents,
} from "@getpaseo/plugin/server";
import {
  type AgentLister,
  counterpartSeat,
  findSeatAgents,
  formatRoster,
  leadAnnouncement,
  type SeatAgent,
  supervisorsRegisteredIn,
} from "./discovery";
import {
  buildSystemPrompt,
  defaultHumanSeatLabels,
  familyOf,
  paseoToolsFor,
  providerOptionsFor,
  readDefinition,
  seatOfAgent,
  seatOfLabels,
} from "./seat";

type AgentCreateRequest = PluginBeforeRequests["agent.create"];

/**
 * `before("agent.create")`: an agent on the `claude` or `codex` provider with an `slp.role` label
 * gets its seat definition, the SLP-RUNTIME block, and the live roster of the counterpart seat (Lead
 * sees Supervisors and the reverse) in its system prompt. Claude Lead/Supervisor also get
 * `allowedTools: mcp__paseo__*`; the Supervisor loses Write/Edit/Agent/Task, a Claude Peer loses
 * Agent/Task. Peer and Supervisor lose Paseo tools through the returned `paseoTools`. A claude/codex
 * request that names no seat and no parent — a Human made it directly, not another agent —
 * defaults to Peer and is tagged `slp.origin=human` (see `defaultHumanSeatLabels`).
 */
export async function withSeatConfig(
  request: AgentCreateRequest,
  agents: AgentLister,
): Promise<AgentCreateRequest | undefined> {
  const family = familyOf(request.config.provider);
  let seat = seatOfLabels(request.labels);
  let labels = request.labels;
  if (!seat && family) {
    const defaulted = defaultHumanSeatLabels(request.labels);
    if (defaulted) {
      seat = "peer";
      labels = defaulted;
    }
  }
  if (!seat) return undefined;
  if (!family) {
    console.log(
      `slp: ${seat} label on provider ${request.config.provider} ignored: SLP seats run on claude or codex`,
    );
    return undefined;
  }
  const definition = await readDefinition(request.config.cwd, seat);
  let roster = "";
  const other = counterpartSeat(seat);
  if (other) {
    try {
      roster = formatRoster(other, await findSeatAgents(agents, other));
    } catch (error) {
      console.error(`slp: could not list ${other} agents: ${String(error)}`);
    }
  }
  const providerOptions = providerOptionsFor(seat, family, request.config.providerOptions);
  const paseoTools = paseoToolsFor(seat, request.paseoTools);
  const systemPrompt = [
    buildSystemPrompt(seat, family, definition.body, request.config.systemPrompt),
    roster,
  ]
    .filter(Boolean)
    .join("\n\n");
  console.log(
    `slp: ${seat}/${family} ← ${definition.source}${roster ? ` (+roster ${other})` : ""}`,
  );
  return {
    ...request,
    ...(labels !== request.labels ? { labels } : {}),
    ...(paseoTools ? { paseoTools } : {}),
    config: {
      ...request.config,
      systemPrompt,
      ...(providerOptions === request.config.providerOptions ? {} : { providerOptions }),
    },
  };
}

/**
 * `on("agent.turn_ended")`: after a Lead's first turn, tell each Supervisor it did not register
 * with. An idle Supervisor hears it now; a running one when its own turn ends. The Supervisor is
 * told when the Lead ends its turn rather than at creation, because telling it at creation made it
 * busy exactly when the Lead checked `get_agent_status`: both deferred and nobody moved (measured
 * 2026-09-24). The message is information, not authority.
 */
export function createLeadAnnouncer() {
  const announcedLeads = new Set<string>();
  const pendingBySupervisor = new Map<string, SeatAgent[]>();

  return async (
    event: PluginLifecycleEvents["agent.turn_ended"],
    context: PluginHookContext,
  ): Promise<void> => {
    const seat = seatOfAgent(event.agent);
    if (seat === "supervisor") {
      const pending = pendingBySupervisor.get(event.agent.id);
      if (!pending?.length) return;
      pendingBySupervisor.delete(event.agent.id);
      for (const lead of pending) {
        await context.paseo.agents.ref(event.agent.id).send(leadAnnouncement(lead));
        console.log(
          `slp: supervisor ${event.agent.id} finished its turn → told about lead ${lead.id}`,
        );
      }
      return;
    }
    if (seat !== "lead" || announcedLeads.has(event.agent.id)) return;
    announcedLeads.add(event.agent.id);
    const supervisors = await findSeatAgents(context.paseo.agents, "supervisor", event.agent.id);
    if (supervisors.length === 0) return;
    const registered = supervisorsRegisteredIn(
      event.timeline,
      supervisors.map((s) => s.id),
    );
    const lead: SeatAgent = {
      id: event.agent.id,
      seat: "lead",
      title: event.agent.title,
      cwd: event.agent.cwd,
      status: "idle",
      workspaceId: event.agent.workspaceId,
    };
    for (const supervisor of supervisors) {
      if (registered.has(supervisor.id)) continue;
      if (supervisor.status !== "idle") {
        pendingBySupervisor.set(supervisor.id, [
          ...(pendingBySupervisor.get(supervisor.id) ?? []),
          lead,
        ]);
        continue;
      }
      await context.paseo.agents.ref(supervisor.id).send(leadAnnouncement(lead));
      console.log(`slp: told supervisor ${supervisor.id} about new lead ${lead.id}`);
    }
  };
}

/** `on("agent.permission_requested")`: safety net that allows Paseo tools for Lead and Supervisor. */
export async function allowPaseoTools(
  event: PluginLifecycleEvents["agent.permission_requested"],
  context: PluginHookContext,
): Promise<void> {
  const seat = seatOfAgent(event.agent);
  if (seat !== "lead" && seat !== "supervisor") return;
  if (event.request.kind !== "tool" || !event.request.name.startsWith("mcp__paseo__")) return;
  await context.paseo.agents.ref(event.agent.id).respondToPermission({
    requestId: event.request.id,
    response: { behavior: "allow" },
  });
  console.log(`slp: allowed ${event.request.name} for ${seat} ${event.agent.id}`);
}
