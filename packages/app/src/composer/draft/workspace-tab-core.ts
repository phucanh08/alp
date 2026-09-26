import type { CreateAgentRequestOptions } from "@getpaseo/client/internal/daemon-client";
import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";
import { resolveSubmissionReadiness } from "@/provider-selection/provider-selection";

export interface WorkspaceDraftAutoSubmitConfig {
  provider: string;
  model: string | null;
}

export function shouldAllowEmptyDraftText(input: {
  allowsEmptyAutoSubmit: boolean;
  attachments: readonly unknown[];
}): boolean {
  return input.allowsEmptyAutoSubmit || input.attachments.length > 0;
}

export function validateDraftSubmission(input: {
  text: string;
  allowsEmptyAutoSubmit: boolean;
  composerState: {
    providerDefinitions: unknown[];
    selectedProvider: string | null;
    isModelLoading: boolean;
    effectiveModelId: string | null;
    availableModels: unknown[];
  };
  autoSubmitConfig: WorkspaceDraftAutoSubmitConfig | null;
  workspaceDirectory: string | null;
  hasClient: boolean;
}): string | null {
  const {
    text,
    allowsEmptyAutoSubmit,
    composerState,
    autoSubmitConfig,
    workspaceDirectory,
    hasClient,
  } = input;
  const readiness = resolveSubmissionReadiness({
    text,
    allowsEmptyAutoSubmit,
    providerCount: composerState.providerDefinitions.length,
    selection: {
      provider: composerState.selectedProvider,
      modelId: composerState.effectiveModelId ?? "",
      availableModels: composerState.availableModels,
      isModelLoading: composerState.isModelLoading,
    },
    autoSubmitConfig,
    workspaceDirectory,
    hasClient,
  });
  return readiness.ok ? null : (readiness.reason ?? null);
}

export function buildDraftCreateAgentOptions(input: {
  draftId: string;
  config: AgentSessionConfig;
  workspaceId: string;
  text: string;
  clientMessageId: string;
  images: CreateAgentRequestOptions["images"];
  attachments: CreateAgentRequestOptions["attachments"];
  labels: Record<string, string> | null;
}): CreateAgentRequestOptions {
  const { images, attachments, labels } = input;
  return {
    idempotencyKey: input.draftId,
    config: input.config,
    workspaceId: input.workspaceId,
    initialPrompt: input.text,
    clientMessageId: input.clientMessageId,
    ...(images && images.length > 0 ? { images } : {}),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    ...(labels ? { labels } : {}),
  };
}
