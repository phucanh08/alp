import type {
  CreateAgentRequestOptions,
  CreateWorkspaceRequestOptions,
} from "@getpaseo/client/internal/daemon-client";
import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";
import type { SeatLabelsFor } from "./slp-seat";

export type WorkspaceInitialAgent = NonNullable<CreateWorkspaceRequestOptions["agent"]>;

function withSeatLabels(
  agent: WorkspaceInitialAgent & { config: AgentSessionConfig },
  seatLabelsFor: SeatLabelsFor,
): WorkspaceInitialAgent {
  const labels = seatLabelsFor(agent.config.provider);
  return labels ? { ...agent, labels } : agent;
}

/** The first agent of a new workspace, created together with the workspace. */
export function buildWorkspaceInitialAgent(input: {
  draftId: string | undefined;
  config: AgentSessionConfig;
  text: string;
  images: CreateAgentRequestOptions["images"];
  attachments: CreateAgentRequestOptions["attachments"];
  seatLabelsFor: SeatLabelsFor;
}): WorkspaceInitialAgent {
  const { images, attachments } = input;
  return withSeatLabels(
    {
      config: input.config,
      initialPrompt: input.text,
      clientMessageId: `${input.draftId}:initial-message`,
      images: images?.length ? images : undefined,
      attachments: attachments?.length ? attachments : undefined,
    },
    input.seatLabelsFor,
  );
}

/**
 * A retry from the draft tab resends the same first agent with the tab's latest input. The seat
 * was chosen on the New workspace composer, so pass the first attempt's `seatLabelsFor`: labels
 * never come from the retry request, only follow the provider the retry goes out on.
 */
export function buildWorkspaceInitialAgentRetry(input: {
  initialAgent: WorkspaceInitialAgent;
  request: CreateAgentRequestOptions;
  cwd: string;
  seatLabelsFor: SeatLabelsFor;
}): WorkspaceInitialAgent {
  const { initialAgent, request } = input;
  return withSeatLabels(
    {
      config: { ...request.config!, cwd: input.cwd },
      initialPrompt: request.initialPrompt ?? "",
      clientMessageId: initialAgent.clientMessageId,
      images: request.images,
      attachments: request.attachments,
    },
    input.seatLabelsFor,
  );
}
