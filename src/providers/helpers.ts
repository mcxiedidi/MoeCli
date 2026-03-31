import type {
  ModelDescriptor,
  SessionMessage,
  UnifiedMessagePart,
  UnifiedToolCall,
  UnifiedUsage,
} from "./types.js";
import { safeJsonParse, toSingleLineJson } from "../utils/json.js";

export interface OpenAIResponseConversationState {
  previousResponseId?: string;
  sentMessageCount?: number;
  supportsPreviousResponseId?: boolean;
  supportsReasoning?: boolean;
  supportsTools?: boolean;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function buildTextPart(text: string): UnifiedMessagePart {
  return {
    type: "text",
    text,
  };
}

export function buildReasoningPart(text: string): UnifiedMessagePart {
  return {
    type: "reasoning",
    text,
  };
}

export function buildToolCallPart(call: UnifiedToolCall): UnifiedMessagePart {
  return {
    type: "tool-call",
    call,
  };
}

export function createSessionMessage(
  role: SessionMessage["role"],
  parts: UnifiedMessagePart[],
  extra?: Partial<Pick<SessionMessage, "toolCallId" | "toolName" | "isError">>,
): SessionMessage {
  return {
    role,
    parts,
    timestamp: nowIso(),
    ...(extra?.toolCallId ? { toolCallId: extra.toolCallId } : {}),
    ...(extra?.toolName ? { toolName: extra.toolName } : {}),
    ...(typeof extra?.isError === "boolean" ? { isError: extra.isError } : {}),
  };
}

export function createAssistantMessage(
  text: string,
  reasoning: string,
  toolCalls: UnifiedToolCall[],
): SessionMessage {
  const parts: UnifiedMessagePart[] = [];

  if (reasoning.trim()) {
    parts.push(buildReasoningPart(reasoning));
  }
  if (text.trim()) {
    parts.push(buildTextPart(text));
  }
  for (const toolCall of toolCalls) {
    parts.push(buildToolCallPart(toolCall));
  }

  return createSessionMessage("assistant", parts);
}

export function createUserMessage(text: string): SessionMessage {
  return createSessionMessage("user", [buildTextPart(text)]);
}

export function createToolResultMessage(
  toolCall: UnifiedToolCall,
  output: string,
  isError = false,
): SessionMessage {
  return createSessionMessage("tool", [buildTextPart(output)], {
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    isError,
  });
}

export function collectText(parts: UnifiedMessagePart[]): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function collectReasoning(parts: UnifiedMessagePart[]): string {
  return parts
    .filter((part) => part.type === "reasoning")
    .map((part) => part.text)
    .join("");
}

export function collectToolCalls(parts: UnifiedMessagePart[]): UnifiedToolCall[] {
  return parts
    .filter((part): part is Extract<UnifiedMessagePart, { type: "tool-call" }> => {
      return part.type === "tool-call";
    })
    .map((part) => part.call);
}

export function getMessageText(message: SessionMessage): string {
  const text = collectText(message.parts);
  if (text.trim()) {
    return text;
  }

  const reasoning = collectReasoning(message.parts);
  if (reasoning.trim()) {
    return reasoning;
  }

  const toolCalls = collectToolCalls(message.parts);
  if (toolCalls.length > 0) {
    return toolCalls
      .map((call) => `${call.name}(${call.argumentsText})`)
      .join("\n");
  }

  return "";
}

export function tryParseToolArguments(argumentsText: string): unknown {
  const parsed = safeJsonParse(argumentsText);
  return parsed ?? { raw: argumentsText };
}

export function stringifyToolOutput(output: unknown): string {
  if (typeof output === "string") {
    return output;
  }
  return toSingleLineJson(output);
}

export function normalizeUsage(
  raw: Record<string, unknown> | undefined,
): UnifiedUsage | undefined {
  if (!raw) {
    return undefined;
  }

  const inputTokens =
    numberFromUnknown(raw.input_tokens) ??
    numberFromUnknown(raw.inputTokens) ??
    numberFromUnknown(raw.prompt_tokens) ??
    numberFromUnknown(raw.promptTokenCount);
  const outputTokens =
    numberFromUnknown(raw.output_tokens) ??
    numberFromUnknown(raw.outputTokens) ??
    numberFromUnknown(raw.completion_tokens) ??
    numberFromUnknown(raw.candidatesTokenCount);
  const totalTokens =
    numberFromUnknown(raw.total_tokens) ??
    numberFromUnknown(raw.totalTokens) ??
    numberFromUnknown(raw.totalTokenCount);

  if (
    typeof inputTokens !== "number" &&
    typeof outputTokens !== "number" &&
    typeof totalTokens !== "number"
  ) {
    return undefined;
  }

  return {
    ...(typeof inputTokens === "number" ? { inputTokens } : {}),
    ...(typeof outputTokens === "number" ? { outputTokens } : {}),
    ...(typeof totalTokens === "number" ? { totalTokens } : {}),
  };
}

export function numberFromUnknown(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function getResponseConversationState(
  value: unknown,
): OpenAIResponseConversationState {
  if (!value || typeof value !== "object") {
    return {};
  }

  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.previousResponseId === "string"
      ? { previousResponseId: record.previousResponseId }
      : {}),
    ...(typeof record.sentMessageCount === "number"
      ? { sentMessageCount: record.sentMessageCount }
      : {}),
    ...(typeof record.supportsPreviousResponseId === "boolean"
      ? { supportsPreviousResponseId: record.supportsPreviousResponseId }
      : {}),
    ...(typeof record.supportsReasoning === "boolean"
      ? { supportsReasoning: record.supportsReasoning }
      : {}),
    ...(typeof record.supportsTools === "boolean"
      ? { supportsTools: record.supportsTools }
      : {}),
  };
}

export function toModelDescriptor(
  id: string,
  label: string,
  provider: ModelDescriptor["provider"],
  source: ModelDescriptor["source"],
  raw?: ModelDescriptor["raw"],
): ModelDescriptor {
  return {
    id,
    label,
    provider,
    source,
    ...(raw === undefined ? {} : { raw }),
  };
}
