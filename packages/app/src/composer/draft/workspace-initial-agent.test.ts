import { describe, expect, it } from "vitest";
import type { CreateAgentRequestOptions } from "@getpaseo/client/internal/daemon-client";
import type { SlpSettings } from "@/plugins/slp-settings/use-slp-settings";
import { type DraftSeat, resolveDraftSeatLabels } from "./slp-seat";
import {
  buildWorkspaceInitialAgent,
  buildWorkspaceInitialAgentRetry,
} from "./workspace-initial-agent";

const slpOn: SlpSettings = {
  status: "ready",
  enabled: true,
  supervisorModel: null,
  saving: false,
  saveError: null,
  save: async () => true,
};
const slpOff: SlpSettings = { ...slpOn, enabled: false };

// The seat the New workspace composer was on when it sent the first attempt.
function seatAt(settings: SlpSettings, seat: DraftSeat) {
  return (provider: string) => resolveDraftSeatLabels(settings, seat, provider);
}

function initialAgent(seatLabelsFor: (provider: string) => Record<string, string> | null) {
  return initialAgentOn("claude", seatLabelsFor);
}

function initialAgentOn(
  provider: string,
  seatLabelsFor: (provider: string) => Record<string, string> | null,
) {
  return buildWorkspaceInitialAgent({
    draftId: "draft-1",
    config: { provider, cwd: "/repo" },
    text: "build it",
    images: undefined,
    attachments: undefined,
    seatLabelsFor,
  });
}

// What the draft tab sends when its composer retries a new workspace's first agent.
function draftTabRetry(
  labels: Record<string, string> | null,
  provider = "claude",
): CreateAgentRequestOptions {
  return {
    idempotencyKey: "draft-1",
    config: { provider, cwd: "/elsewhere", model: "opus" },
    workspaceId: "ws-1",
    initialPrompt: "build it again",
    clientMessageId: "draft-1:retry",
    ...(labels ? { labels } : {}),
  };
}

describe("new workspace initial agent", () => {
  it("asks for a Lead when the composer is on Lead", () => {
    expect(initialAgent(seatAt(slpOn, "lead")).labels).toEqual({
      "slp.role": "lead",
    });
  });

  it("sends no label for plain chat", () => {
    expect(initialAgent(seatAt(slpOn, "chat"))).not.toHaveProperty("labels");
  });

  it("sends no label when SLP is off on the host", () => {
    expect(initialAgent(seatAt(slpOff, "lead"))).not.toHaveProperty("labels");
  });

  it("sends no label on a provider SLP seats do not run on", () => {
    expect(initialAgentOn("mock", seatAt(slpOn, "lead"))).not.toHaveProperty("labels");
  });
});

describe("new workspace initial agent retry", () => {
  it("keeps the Lead label of the first attempt", () => {
    const retry = buildWorkspaceInitialAgentRetry({
      initialAgent: initialAgent(seatAt(slpOn, "lead")),
      request: draftTabRetry(null),
      cwd: "/repo",
      seatLabelsFor: seatAt(slpOn, "lead"),
    });

    expect(retry.labels).toEqual({ "slp.role": "lead" });
  });

  it("keeps plain chat unlabeled even when the retry request carries a seat", () => {
    const retry = buildWorkspaceInitialAgentRetry({
      initialAgent: initialAgent(seatAt(slpOn, "chat")),
      request: draftTabRetry({ "slp.role": "lead" }),
      cwd: "/repo",
      seatLabelsFor: seatAt(slpOn, "chat"),
    });

    expect(retry).not.toHaveProperty("labels");
  });

  it("drops the Lead label when the retry moves to a provider SLP seats do not run on", () => {
    const retry = buildWorkspaceInitialAgentRetry({
      initialAgent: initialAgent(seatAt(slpOn, "lead")),
      request: draftTabRetry({ "slp.role": "lead" }, "mock"),
      cwd: "/repo",
      seatLabelsFor: seatAt(slpOn, "lead"),
    });

    expect(retry).not.toHaveProperty("labels");
  });

  it("asks for the chosen Lead again when the retry moves back to claude", () => {
    const retry = buildWorkspaceInitialAgentRetry({
      initialAgent: initialAgentOn("mock", seatAt(slpOn, "lead")),
      request: draftTabRetry(null, "claude"),
      cwd: "/repo",
      seatLabelsFor: seatAt(slpOn, "lead"),
    });

    expect(retry.labels).toEqual({ "slp.role": "lead" });
  });

  it("takes the prompt and config from the retry but keeps the workspace cwd and message id", () => {
    const retry = buildWorkspaceInitialAgentRetry({
      initialAgent: initialAgent(seatAt(slpOn, "lead")),
      request: draftTabRetry(null),
      cwd: "/repo",
      seatLabelsFor: seatAt(slpOn, "lead"),
    });

    expect(retry).toEqual({
      config: { provider: "claude", cwd: "/repo", model: "opus" },
      initialPrompt: "build it again",
      clientMessageId: "draft-1:initial-message",
      images: undefined,
      attachments: undefined,
      labels: { "slp.role": "lead" },
    });
  });
});
