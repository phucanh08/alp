import type {
  CreateAgentRequestOptions,
  CreateWorkspaceRequestOptions,
} from "@getpaseo/client/internal/daemon-client";
import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";

export type WorkspaceInitialAgent = NonNullable<CreateWorkspaceRequestOptions["agent"]>;

/** The first agent of a new workspace, created together with the workspace. */
export function buildWorkspaceInitialAgent(input: {
  draftId: string | undefined;
  config: AgentSessionConfig;
  text: string;
  images: CreateAgentRequestOptions["images"];
  attachments: CreateAgentRequestOptions["attachments"];
  labels: Record<string, string> | null;
}): WorkspaceInitialAgent {
  const { images, attachments, labels } = input;
  return {
    config: input.config,
    initialPrompt: input.text,
    clientMessageId: `${input.draftId}:initial-message`,
    images: images?.length ? images : undefined,
    attachments: attachments?.length ? attachments : undefined,
    ...(labels ? { labels } : {}),
  };
}

/**
 * A retry from the draft tab resends the same first agent with the tab's latest input. The seat
 * was chosen on the New workspace composer, so the labels always come from the first attempt,
 * never from the retry request.
 */
export function buildWorkspaceInitialAgentRetry(input: {
  initialAgent: WorkspaceInitialAgent;
  request: CreateAgentRequestOptions;
  cwd: string;
}): WorkspaceInitialAgent {
  const { initialAgent, request } = input;
  return {
    ...initialAgent,
    config: { ...request.config!, cwd: input.cwd },
    initialPrompt: request.initialPrompt ?? "",
    clientMessageId: initialAgent.clientMessageId,
    images: request.images,
    attachments: request.attachments,
  };
}
