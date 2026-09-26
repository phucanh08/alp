import { describe, expect, it } from "vitest";
import type { CreateAgentRequestOptions } from "@getpaseo/client/internal/daemon-client";
import type { SlpSettings } from "@/plugins/slp-settings/use-slp-settings";
import { resolveDraftSeatLabels } from "./slp-seat";
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

function initialAgent(labels: Record<string, string> | null) {
  return buildWorkspaceInitialAgent({
    draftId: "draft-1",
    config: { provider: "claude", cwd: "/repo" },
    text: "build it",
    images: undefined,
    attachments: undefined,
    labels,
  });
}

// What the draft tab sends when its composer retries a new workspace's first agent.
function draftTabRetry(labels: Record<string, string> | null): CreateAgentRequestOptions {
  return {
    idempotencyKey: "draft-1",
    config: { provider: "claude", cwd: "/elsewhere", model: "opus" },
    workspaceId: "ws-1",
    initialPrompt: "build it again",
    clientMessageId: "draft-1:retry",
    ...(labels ? { labels } : {}),
  };
}

describe("new workspace initial agent", () => {
  it("asks for a Lead when the composer is on Lead", () => {
    expect(initialAgent(resolveDraftSeatLabels(slpOn, "lead")).labels).toEqual({
      "slp.role": "lead",
    });
  });

  it("sends no label for plain chat", () => {
    expect(initialAgent(resolveDraftSeatLabels(slpOn, "chat"))).not.toHaveProperty("labels");
  });

  it("sends no label when SLP is off on the host", () => {
    expect(initialAgent(resolveDraftSeatLabels(slpOff, "lead"))).not.toHaveProperty("labels");
  });
});

describe("new workspace initial agent retry", () => {
  it("keeps the Lead label of the first attempt", () => {
    const retry = buildWorkspaceInitialAgentRetry({
      initialAgent: initialAgent({ "slp.role": "lead" }),
      request: draftTabRetry(null),
      cwd: "/repo",
    });

    expect(retry.labels).toEqual({ "slp.role": "lead" });
  });

  it("keeps plain chat unlabeled even when the retry request carries a seat", () => {
    const retry = buildWorkspaceInitialAgentRetry({
      initialAgent: initialAgent(null),
      request: draftTabRetry({ "slp.role": "lead" }),
      cwd: "/repo",
    });

    expect(retry).not.toHaveProperty("labels");
  });

  it("takes the prompt and config from the retry but keeps the workspace cwd and message id", () => {
    const retry = buildWorkspaceInitialAgentRetry({
      initialAgent: initialAgent({ "slp.role": "lead" }),
      request: draftTabRetry(null),
      cwd: "/repo",
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
