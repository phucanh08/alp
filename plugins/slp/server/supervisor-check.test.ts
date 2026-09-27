import { expect, test } from "vitest";
import { SEAT_LABEL } from "./seat";
import { createSupervisorCheck, SUPERVISOR_CHECK_TICK_MS } from "./supervisor-check";

const MINUTE = 60_000;
const PARENT = "paseo.parent-agent-id";

interface FakeAgent {
  id: string;
  provider: string;
  cwd: string;
  status: string;
  title?: string | null;
  labels?: Record<string, string>;
  archivedAt?: string | null;
}

const lead = (status: string, id = "L1"): FakeAgent => ({
  id,
  provider: "claude",
  cwd: `/repo/${id}`,
  status,
  title: `Lead ${id}`,
  labels: { [SEAT_LABEL]: "lead" },
});
const peer = (id: string, parent: string, status: string): FakeAgent => ({
  id,
  provider: "codex",
  cwd: `/repo/${id}`,
  status,
  title: `Peer ${id}`,
  labels: { [SEAT_LABEL]: "peer", [PARENT]: parent },
});
const supervisor = (status: string, id = "S1"): FakeAgent => ({
  id,
  provider: "claude",
  cwd: "/sup",
  status,
  title: "Supervisor",
  labels: { [SEAT_LABEL]: "supervisor" },
});

/** A `send_agent_prompt` tool call as it sits in an agent timeline. */
const sendTo = (callId: string, agentId: string) => ({
  type: "tool_call",
  callId,
  name: "mcp__paseo__send_agent_prompt",
  detail: { type: "unknown", input: { agentId, prompt: "SLP-REPORT …" }, output: null },
  status: "completed",
  error: null,
});

/** Fake host: `agents` and each agent's timeline are live and mutable; `sent` records nudges. */
function fakeHost(agents: FakeAgent[]) {
  const timelines: Record<string, unknown[]> = {};
  const sent: Array<{ agentId: string; text: string }> = [];
  const host = {
    agents: {
      async list() {
        return { entries: agents.map((agent) => ({ agent })), pageInfo: { nextCursor: null } };
      },
      ref(agentId: string) {
        return {
          async send(text: string) {
            sent.push({ agentId, text });
          },
          timeline: {
            async refetch() {
              return { entries: (timelines[agentId] ?? []).map((item) => ({ item })) };
            },
          },
        };
      },
    },
  };
  return { host, agents, timelines, sent };
}

/** Ticks once per minute from `from` to `to` inclusive, every tick reading `minutes`. */
async function tickMinutes(
  check: ReturnType<typeof createSupervisorCheck>,
  host: ReturnType<typeof fakeHost>["host"],
  minutes: number,
  from: number,
  to: number,
) {
  for (let minute = from; minute <= to; minute++) await check.tick(host, minutes, minute * MINUTE);
}

test("the check ticks once a minute", () => {
  expect(SUPERVISOR_CHECK_TICK_MS).toBe(MINUTE);
});

test("a working Lead silent for N minutes gets one nudge to the Supervisor, not before", async () => {
  const fx = fakeHost([lead("running"), supervisor("idle")]);
  const check = createSupervisorCheck();

  await tickMinutes(check, fx.host, 10, 0, 9);
  expect(fx.sent).toEqual([]);

  await check.tick(fx.host, 10, 10 * MINUTE);
  expect(fx.sent).toHaveLength(1);
  expect(fx.sent[0].agentId).toBe("S1");
  const text = fx.sent[0].text;
  expect(text.split("\n")[0]).toBe("[plugin slp] SLP-CHECK");
  expect(text).toContain("`L1`");
  expect(text).toContain("`Lead L1`");
  expect(text).toContain("10 phút");
  expect(text).toContain("Nhắc liên tiếp chưa có tin Lead gửi Supervisor: 1.");
});

test("the next nudge for the same Lead comes N minutes later and counts up", async () => {
  const fx = fakeHost([lead("running"), supervisor("idle")]);
  const check = createSupervisorCheck();

  await tickMinutes(check, fx.host, 10, 0, 19);
  expect(fx.sent).toHaveLength(1);

  await check.tick(fx.host, 10, 20 * MINUTE);
  expect(fx.sent).toHaveLength(2);
  expect(fx.sent[1].text).toContain("20 phút");
  expect(fx.sent[1].text).toContain("Nhắc liên tiếp chưa có tin Lead gửi Supervisor: 2.");
});

test("a message the Lead sends a Supervisor resets its clock and its nudge count", async () => {
  const fx = fakeHost([lead("running"), supervisor("idle")]);
  const check = createSupervisorCheck();

  await tickMinutes(check, fx.host, 10, 0, 20);
  expect(fx.sent).toHaveLength(2);

  // Minute 23: the Lead ends a turn in which it reported to S1.
  await tickMinutes(check, fx.host, 10, 21, 23);
  const timeline = [sendTo("r1", "S1")];
  fx.timelines.L1 = timeline;
  await check.turnEnded(fx.host, lead("running"), timeline);

  await tickMinutes(check, fx.host, 10, 24, 32);
  expect(fx.sent).toHaveLength(2);

  await check.tick(fx.host, 10, 33 * MINUTE);
  expect(fx.sent).toHaveLength(3);
  expect(fx.sent[2].text).toContain("10 phút");
  expect(fx.sent[2].text).toContain("Nhắc liên tiếp chưa có tin Lead gửi Supervisor: 1.");
});

test("a report made mid-turn is found in the Lead's timeline before a nudge goes out", async () => {
  const fx = fakeHost([lead("running"), supervisor("idle")]);
  const check = createSupervisorCheck();

  await tickMinutes(check, fx.host, 10, 0, 6);
  // Minute 7: still in the same turn, the Lead reports to S1; no turn_ended yet.
  fx.timelines.L1 = [sendTo("r1", "S1")];
  await tickMinutes(check, fx.host, 10, 7, 19);
  expect(fx.sent).toEqual([]);

  await check.tick(fx.host, 10, 20 * MINUTE);
  expect(fx.sent).toHaveLength(1);
});

test("a message the Lead sent to someone other than a Supervisor does not reset the clock", async () => {
  const fx = fakeHost([lead("running"), peer("P1", "L1", "idle"), supervisor("idle")]);
  const check = createSupervisorCheck();

  await tickMinutes(check, fx.host, 10, 0, 5);
  const timeline = [sendTo("p1", "P1")];
  fx.timelines.L1 = timeline;
  await check.turnEnded(fx.host, lead("running"), timeline);

  await tickMinutes(check, fx.host, 10, 6, 10);
  expect(fx.sent).toHaveLength(1);
});

test("reports already in the Lead's timeline when slp first sees it do not hold back the nudge", async () => {
  const fx = fakeHost([lead("running"), supervisor("idle")]);
  fx.timelines.L1 = [sendTo("old", "S1")];
  const check = createSupervisorCheck();

  await tickMinutes(check, fx.host, 10, 0, 10);
  expect(fx.sent).toHaveLength(1);
});

test("a Lead only waiting for the Human is not nudged and its clock stops", async () => {
  const fx = fakeHost([lead("idle"), peer("P1", "L1", "idle"), supervisor("idle")]);
  const check = createSupervisorCheck();

  await tickMinutes(check, fx.host, 10, 0, 30);
  expect(fx.sent).toEqual([]);

  // Works minutes 31–35, waits for the Human 36–60, works again from 61.
  fx.agents[0] = lead("running");
  await tickMinutes(check, fx.host, 10, 31, 35);
  fx.agents[0] = lead("idle");
  await tickMinutes(check, fx.host, 10, 36, 60);
  fx.agents[0] = lead("running");
  await tickMinutes(check, fx.host, 10, 61, 64);
  expect(fx.sent).toEqual([]);

  await check.tick(fx.host, 10, 65 * MINUTE);
  expect(fx.sent).toHaveLength(1);
  expect(fx.sent[0].text).toContain("10 phút");
});

test("a running Peer of the Lead keeps the Lead working; another Lead's Peer does not", async () => {
  const fx = fakeHost([
    lead("idle"),
    lead("idle", "L2"),
    peer("P1", "L1", "running"),
    supervisor("idle"),
  ]);
  const check = createSupervisorCheck();

  await tickMinutes(check, fx.host, 10, 0, 10);
  expect(fx.sent).toHaveLength(1);
  expect(fx.sent[0].text).toContain("`L1`");
  expect(fx.sent[0].text).not.toContain("`L2`");
});

test("a turn that starts and ends between two ticks still counts as working", async () => {
  const fx = fakeHost([lead("idle"), supervisor("idle")]);
  const check = createSupervisorCheck();

  await check.tick(fx.host, 10, 0);
  for (let minute = 1; minute <= 10; minute++) {
    check.turnStarted("L1");
    await check.tick(fx.host, 10, minute * MINUTE);
  }
  expect(fx.sent).toHaveLength(1);
});

test("0 minutes turns the nudge off; turning it back on starts a fresh clock", async () => {
  const fx = fakeHost([lead("running"), supervisor("idle")]);
  const check = createSupervisorCheck();

  await tickMinutes(check, fx.host, 0, 0, 30);
  expect(fx.sent).toEqual([]);

  await tickMinutes(check, fx.host, 10, 31, 40);
  expect(fx.sent).toEqual([]);
  await check.tick(fx.host, 10, 41 * MINUTE);
  expect(fx.sent).toHaveLength(1);
});

test("a changed interval applies from the next tick", async () => {
  const fx = fakeHost([lead("running"), supervisor("idle")]);
  const check = createSupervisorCheck();

  await tickMinutes(check, fx.host, 10, 0, 4);
  expect(fx.sent).toEqual([]);
  await check.tick(fx.host, 5, 5 * MINUTE);
  expect(fx.sent).toHaveLength(1);
  expect(fx.sent[0].text).toContain("5 phút");
});

test("with no Supervisor on the host nothing is sent and nothing throws", async () => {
  const fx = fakeHost([lead("running"), supervisor("closed")]);
  const check = createSupervisorCheck();

  await expect(tickMinutes(check, fx.host, 10, 0, 30)).resolves.toBeUndefined();
  fx.agents.pop();
  await expect(tickMinutes(check, fx.host, 10, 31, 60)).resolves.toBeUndefined();
  expect(fx.sent).toEqual([]);
});

test("a nudge waits while the Supervisor is running and goes out once it is idle", async () => {
  const fx = fakeHost([lead("running"), supervisor("running")]);
  const check = createSupervisorCheck();

  await tickMinutes(check, fx.host, 10, 0, 14);
  expect(fx.sent).toEqual([]);

  fx.agents[1] = supervisor("idle");
  await check.tick(fx.host, 10, 15 * MINUTE);
  expect(fx.sent).toHaveLength(1);
  expect(fx.sent[0].text).toContain("15 phút");
});

test("two Leads due in the same tick reach the Supervisor one tick apart", async () => {
  const fx = fakeHost([lead("running"), lead("running", "L2"), supervisor("idle")]);
  const check = createSupervisorCheck();

  await tickMinutes(check, fx.host, 10, 0, 10);
  expect(fx.sent).toHaveLength(1);
  expect(fx.sent[0].text).toContain("`L1`");

  await check.tick(fx.host, 10, 11 * MINUTE);
  expect(fx.sent).toHaveLength(2);
  expect(fx.sent[1].text).toContain("`L2`");
  expect(fx.sent[1].text).toContain("11 phút");
});
