import type { JsonValue } from "../types/shared.js";

export type ProviderKind =
  | "openai"
  | "openai-compatible"
  | "anthropic"
  | "bedrock"
  | "gemini";

export type OpenAICompatibleTransportMode = "auto" | "responses" | "chat";

export type AgentExecutionMode = "background" | "worktree" | "tmux";

export interface ProviderProfileMeta {
  id: string;
  name: string;
  kind: ProviderKind;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  baseUrl?: string | undefined;
  region?: string | undefined;
  projectId?: string | undefined;
  awsProfile?: string | undefined;
  apiVersion?: string | undefined;
  extraHeaders?: Record<string, string> | undefined;
}

export interface ProviderSecretRef {
  profileId: string;
  apiKey?: string | undefined;
  accessKeyId?: string | undefined;
  secretAccessKey?: string | undefined;
  sessionToken?: string | undefined;
}

export interface ResolvedProviderProfile {
  meta: ProviderProfileMeta;
  secrets: ProviderSecretRef;
}

export interface ProviderCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  modelListing: boolean;
  reasoningDeltas: boolean;
  toolCallDeltas: boolean;
}

export interface ModelDescriptor {
  id: string;
  label: string;
  provider: ProviderKind;
  source: "remote" | "manual" | "suggested";
  supportsTools?: boolean | undefined;
  supportsReasoning?: boolean | undefined;
  contextWindow?: number | undefined;
  raw?: JsonValue | undefined;
}

export interface UnifiedToolCall {
  id: string;
  name: string;
  argumentsText: string;
}

export interface UnifiedUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
}

export type UnifiedMessagePart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "reasoning";
      text: string;
    }
  | {
      type: "tool-call";
      call: UnifiedToolCall;
    };

export interface SessionMessage {
  role: "system" | "user" | "assistant" | "tool";
  parts: UnifiedMessagePart[];
  toolCallId?: string | undefined;
  toolName?: string | undefined;
  isError?: boolean | undefined;
  timestamp: string;
}

export interface UnifiedToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type UnifiedStreamEvent =
  | {
      type: "status";
      message: string;
      tone?: "primary" | "success" | "warning" | "danger" | "info";
    }
  | { type: "text-delta"; delta: string }
  | { type: "reasoning-delta"; delta: string }
  | { type: "tool-call-delta"; id: string; name: string; delta: string }
  | { type: "tool-call"; call: UnifiedToolCall }
  | { type: "tool-execution-start"; call: UnifiedToolCall }
  | {
      type: "tool-result";
      call: UnifiedToolCall;
      output: string;
      isError?: boolean | undefined;
    }
  | { type: "usage"; usage: UnifiedUsage }
  | { type: "message-start" }
  | { type: "message-stop"; finishReason?: string | undefined };

export interface CompletionRequest {
  profile: ResolvedProviderProfile;
  model: string;
  systemPrompt?: string | undefined;
  messages: SessionMessage[];
  tools?: UnifiedToolDefinition[] | undefined;
  maxOutputTokens?: number | undefined;
  temperature?: number | undefined;
  signal?: AbortSignal | undefined;
  providerState?: JsonValue | undefined;
}

export interface CompletionResult {
  assistantMessage: SessionMessage;
  toolCalls: UnifiedToolCall[];
  finishReason?: string | undefined;
  usage?: UnifiedUsage | undefined;
  providerState?: JsonValue | undefined;
}

export interface ProviderValidationResult {
  ok: boolean;
  message: string;
}

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  readonly displayName: string;

  getCapabilities(profile: ResolvedProviderProfile): ProviderCapabilities;
  getSuggestedModels(profile: ResolvedProviderProfile): ModelDescriptor[];
  validateProfile(
    profile: ResolvedProviderProfile,
  ): Promise<ProviderValidationResult>;
  listModels(profile: ResolvedProviderProfile): Promise<ModelDescriptor[]>;
  streamResponse(
    request: CompletionRequest,
  ): AsyncGenerator<UnifiedStreamEvent, CompletionResult>;
}
