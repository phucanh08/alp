import { type AgentEntryLike, type AgentLister, agentPromptsIn, listLiveAgents } from "./discovery";
import { seatOfAgent } from "./seat";

/** How often `index.server.ts` runs `tick`; also the longest step one tick adds to a clock. */
export const SUPERVISOR_CHECK_TICK_MS = 60_000;

/** Timeline entries `tick` reads from a Lead before it nudges; reports older than that are old. */
const TIMELINE_TAIL = 200;

const PARENT_AGENT_ID_LABEL = "alp.parent-agent-id";

/** The slice of `AlpApi` the check needs; kept narrow so tests need no SDK. */
export interface SupervisorCheckHost {
  agents: AgentLister & {
    ref(agentId: string): {
      send(text: string): Promise<void>;
      timeline: {
        refetch(options: {
          direction: "tail";
          limit: number;
        }): Promise<{ entries: ReadonlyArray<{ item: unknown }> }>;
      };
    };
  };
}

interface LeadClock {
  /** Working time without a message to a Supervisor; the minutes the nudge reports. */
  quietMs: number;
  /** Working time since the last nudge (or report): the next nudge is due at N minutes. */
  sinceNudgeMs: number;
  /** Nudges in a row without a report. */
  nudges: number;
  /** `send_agent_prompt` call ids to a Supervisor already seen; a new one is a report. */
  reports: Set<string>;
}

/** The message a Supervisor gets when a working Lead has not messaged it for N minutes. */
export function supervisorCheckMessage(
  lead: { id: string; title: string | null; cwd: string },
  quietMinutes: number,
  nudges: number,
): string {
  return [
    "[plugin slp] SLP-CHECK",
    `Lead \`${lead.id}\` · title \`${lead.title ?? "-"}\` · Root \`${lead.cwd}\`: ${quietMinutes} phút làm việc (Lead hoặc Peer của nó đang chạy) chưa gửi tin nào cho Supervisor.`,
    `Nhắc liên tiếp chưa có tin Lead gửi Supervisor: ${nudges}.`,
    "Tin này từ plugin, không phải Human.",
  ].join("\n");
}

/** The Lead an agent works for: itself when it is a Lead, else the nearest Lead up its parents. */
function leadOf(
  agent: AgentEntryLike["agent"],
  byId: ReadonlyMap<string, AgentEntryLike["agent"]>,
): string | null {
  const visited = new Set<string>();
  let current: AgentEntryLike["agent"] | undefined = agent;
  while (current && !visited.has(current.id)) {
    if (seatOfAgent(current) === "lead") return current.id;
    visited.add(current.id);
    const parent: string | undefined = current.labels?.[PARENT_AGENT_ID_LABEL];
    current = parent ? byId.get(parent) : undefined;
  }
  return null;
}

async function supervisorPromptIds(
  host: SupervisorCheckHost,
  leadId: string,
  supervisorIds: readonly string[],
): Promise<string[]> {
  const page = await host.agents.ref(leadId).timeline.refetch({
    direction: "tail",
    limit: TIMELINE_TAIL,
  });
  return agentPromptsIn(
    page.entries.map(({ item }) => item),
    supervisorIds,
  ).map(({ callId }) => callId);
}

/**
 * Supervisor check: a Lead is working while it, or an agent under it (its Peers), is running or
 * started a turn since the last tick. Only working time runs its clock, so a Lead that only waits
 * for the Human is never nudged. Once a working Lead has sent no `send_agent_prompt` to a
 * Supervisor for N minutes, `tick` sends the host's live Supervisor `supervisorCheckMessage`; the
 * next nudge for that Lead comes N working minutes later. A report — a `send_agent_prompt` call to a
 * Supervisor that was not in the Lead's timeline before — resets the clock and the nudge count.
 * Reports are read from the `agent.turn_ended` timeline and, because a Lead waiting on Peers can
 * stay inside one turn for a long time, from the tail of the Lead's timeline right before a nudge.
 * A nudge waits while the Supervisor is running, and a tick sends at most one: `agents.ref().send`
 * replaces a running turn.
 * State lives in memory; a plugin restart starts every clock over.
 */
export function createSupervisorCheck(tickMs = SUPERVISOR_CHECK_TICK_MS) {
  const clocks = new Map<string, LeadClock>();
  const startedSinceTick = new Set<string>();
  let lastTickAt: number | null = null;
  let ticking = false;

  const reset = (clock: LeadClock) => {
    clock.quietMs = 0;
    clock.sinceNudgeMs = 0;
    clock.nudges = 0;
  };

  /** Records new report ids; true when there was one. */
  const recordReports = (clock: LeadClock, callIds: readonly string[]): boolean => {
    let reported = false;
    for (const callId of callIds) {
      if (clock.reports.has(callId)) continue;
      clock.reports.add(callId);
      reported = true;
    }
    return reported;
  };

  const runTick = async (
    host: SupervisorCheckHost,
    minutes: number,
    now: number,
  ): Promise<void> => {
    if (minutes <= 0) {
      clocks.clear();
      startedSinceTick.clear();
      lastTickAt = null;
      return;
    }
    const step = lastTickAt === null ? 0 : Math.min(Math.max(now - lastTickAt, 0), 2 * tickMs);
    lastTickAt = now;
    const started = new Set(startedSinceTick);
    startedSinceTick.clear();

    const agents = (await listLiveAgents(host.agents))
      .map(({ agent }) => agent)
      .filter((agent) => !agent.archivedAt);
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    const supervisors = agents.filter((agent) => seatOfAgent(agent) === "supervisor");
    const supervisorIds = supervisors.map(({ id }) => id);
    const target = supervisors.find((agent) => agent.status !== "closed");
    // One nudge per tick: the list snapshot still says idle after the first, and a second send
    // would replace the turn the first one started.
    let supervisorFree = target?.status === "idle";

    const working = new Set<string>();
    for (const agent of agents) {
      if (agent.status !== "running" && !started.has(agent.id)) continue;
      const leadId = leadOf(agent, byId);
      if (leadId) working.add(leadId);
    }

    for (const leadId of clocks.keys()) if (!byId.has(leadId)) clocks.delete(leadId);

    const dueMs = minutes * 60_000;
    for (const leadId of working) {
      const lead = byId.get(leadId);
      if (!lead) continue;
      let clock = clocks.get(leadId);
      if (!clock) {
        clock = { quietMs: 0, sinceNudgeMs: 0, nudges: 0, reports: new Set() };
        clocks.set(leadId, clock);
        try {
          recordReports(clock, await supervisorPromptIds(host, leadId, supervisorIds));
        } catch (error) {
          console.error(`slp: could not read lead ${leadId} timeline: ${String(error)}`);
        }
      }
      clock.quietMs += step;
      clock.sinceNudgeMs += step;
      if (clock.sinceNudgeMs < dueMs) continue;
      if (!target || !supervisorFree) continue;
      try {
        if (recordReports(clock, await supervisorPromptIds(host, leadId, supervisorIds))) {
          reset(clock);
          continue;
        }
        const nudges = clock.nudges + 1;
        await host.agents
          .ref(target.id)
          .send(
            supervisorCheckMessage(
              { id: lead.id, title: lead.title ?? null, cwd: lead.cwd },
              Math.floor(clock.quietMs / 60_000),
              nudges,
            ),
          );
        supervisorFree = false;
        clock.nudges = nudges;
        clock.sinceNudgeMs = 0;
        console.log(`slp: asked supervisor ${target.id} to check lead ${leadId} (#${nudges})`);
      } catch (error) {
        console.error(`slp: could not nudge supervisor about lead ${leadId}: ${String(error)}`);
      }
    }
  };

  return {
    /** `on("agent.turn_started")`: the agent counts as running at the next tick. */
    turnStarted(agentId: string): void {
      startedSinceTick.add(agentId);
    },

    /** `on("agent.turn_ended")`: a Lead's new message to a Supervisor resets its clock. */
    async turnEnded(
      host: SupervisorCheckHost,
      agent: { id: string; provider: string; labels?: Record<string, string> },
      timeline: unknown,
    ): Promise<void> {
      if (seatOfAgent(agent) !== "lead") return;
      const clock = clocks.get(agent.id);
      if (!clock) return;
      const supervisorIds = (await listLiveAgents(host.agents))
        .filter(({ agent: entry }) => seatOfAgent(entry) === "supervisor")
        .map(({ agent: entry }) => entry.id);
      const callIds = agentPromptsIn(timeline, supervisorIds).map(({ callId }) => callId);
      if (recordReports(clock, callIds)) reset(clock);
    },

    /** One pass at `now` (ms) with the current setting; `minutes <= 0` is off and clears every clock. */
    async tick(host: SupervisorCheckHost, minutes: number, now: number): Promise<void> {
      if (ticking) return;
      ticking = true;
      try {
        await runTick(host, minutes, now);
      } finally {
        ticking = false;
      }
    },
  };
}
