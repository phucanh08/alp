import type { z } from "zod";
import type { ProviderAlpToolsPolicy } from "@alp/protocol/provider-config";

export interface AlpToolExecutionContext {
  signal?: AbortSignal;
  sendUpdate?: (update: AlpToolResult) => void;
}

export interface AlpToolResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface AlpToolConfig {
  title?: string;
  description?: string;
  inputSchema?: z.ZodRawShape | z.ZodType;
  outputSchema?: z.ZodRawShape;
}

export interface AlpToolDefinition extends AlpToolConfig {
  name: string;
  description: string;
  handler: (input: unknown, context: AlpToolExecutionContext) => Promise<AlpToolResult>;
}

export interface AlpToolCatalog {
  tools: ReadonlyMap<string, AlpToolDefinition>;
  getTool(name: string): AlpToolDefinition | undefined;
  executeTool(
    name: string,
    input: unknown,
    context?: AlpToolExecutionContext,
  ): Promise<AlpToolResult>;
}

export interface AlpToolRuntimeContext {
  callerAgentId?: string;
  alpToolPolicy?: ProviderAlpToolsPolicy;
  enableVoiceTools?: boolean;
  voiceOnly?: boolean;
}

export type AlpToolCatalogFactory = (
  context: AlpToolRuntimeContext,
) => AlpToolCatalog | Promise<AlpToolCatalog>;
