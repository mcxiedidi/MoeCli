import OpenAI from "openai";
import type {
  CompletionRequest,
  CompletionResult,
  ProviderKind,
  ResolvedProviderProfile,
  UnifiedStreamEvent,
  UnifiedToolCall,
} from "./types.js";
import {
  collectToolCalls,
  createAssistantMessage,
  getMessageText,
  type OpenAIResponseConversationState,
  getResponseConversationState,
  normalizeUsage,
} from "./helpers.js";
import { UserError } from "../utils/errors.js";

export function createOpenAIClient(
  profile: ResolvedProviderProfile,
): OpenAI {
  if (!profile.secrets.apiKey?.trim()) {
    throw new UserError(`Profile "${profile.meta.name}" is missing an API key.`);
  }

  return new OpenAI({
    apiKey: profile.secrets.apiKey,
    ...(profile.meta.baseUrl ? { baseURL: profile.meta.baseUrl } : {}),
    defaultHeaders: profile.meta.extraHeaders,
  });
}

function buildOpenAITools(
  request: CompletionRequest,
): Array<Record<string, unknown>> | undefined {
  if (!request.tools?.length) {
    return undefined;
  }

  return request.tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    strict: false,
    parameters: tool.inputSchema,
  }));
}

interface OpenAIResponsesCompatibilityState {
  supportsPreviousResponseId: boolean;
  supportsReasoning: boolean;
  supportsTools: boolean;
}

function getErrorStatus(error: unknown): number | undefined {
  const raw = error as { status?: number | undefined } | undefined;
  return raw?.status;
}

function getErrorText(error: unknown): string {
  const parts = [
    error instanceof Error ? error.message : String(error),
    ...Object.values(
      (error as
        | {
            code?: string | undefined;
            type?: string | undefined;
            name?: string | undefined;
          }
        | undefined) ?? {},
    ),
  ];

  return parts
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join(" ")
    .toLowerCase();
}

function hasCustomBaseUrl(profile: ResolvedProviderProfile): boolean {
  return Boolean(profile.meta.baseUrl?.trim());
}

function isUnsupportedParameterError(
  error: unknown,
  parameterNames: string[],
): boolean {
  const status = getErrorStatus(error);
  if (status !== 400 && status !== 404 && status !== 422) {
    return false;
  }

  const normalized = getErrorText(error);
  if (
    !normalized.includes("unsupported parameter") &&
    !normalized.includes("unknown parameter") &&
    !normalized.includes("not supported")
  ) {
    return parameterNames.some((parameterName) => normalized.includes(parameterName));
  }

  return parameterNames.some((parameterName) => normalized.includes(parameterName));
}

export function isPreviousResponseIdUnsupported(error: unknown): boolean {
  return isUnsupportedParameterError(error, [
    "previous_response_id",
    "previous response id",
  ]);
}

export function isReasoningUnsupported(error: unknown): boolean {
  return isUnsupportedParameterError(error, [
    "reasoning",
    "reasoning.effort",
    "reasoning.summary",
  ]);
}

export function isToolCallingUnsupported(error: unknown): boolean {
  return isUnsupportedParameterError(error, [
    "tools",
    "parallel_tool_calls",
    "tool_choice",
  ]);
}

function getResponsesCompatibilityState(
  kind: ProviderKind,
  request: CompletionRequest,
): OpenAIResponsesCompatibilityState {
  const state = getResponseConversationState(request.providerState);
  return {
    supportsPreviousResponseId: state.supportsPreviousResponseId !== false,
    supportsReasoning:
      kind === "openai" ? state.supportsReasoning !== false : false,
    supportsTools: request.tools?.length ? state.supportsTools !== false : true,
  };
}

function buildOpenAIResponsesInput(
  request: CompletionRequest,
  options?: {
    usePreviousResponseId?: boolean | undefined;
  },
): {
  input: Array<Record<string, unknown>>;
  sentMessageCount: number;
  previousResponseId?: string;
} {
  const state = getResponseConversationState(request.providerState);
  const usePreviousResponseId =
    options?.usePreviousResponseId !== false &&
    state.supportsPreviousResponseId !== false &&
    Boolean(state.previousResponseId);
  const sentMessageCount = usePreviousResponseId ? (state.sentMessageCount ?? 0) : 0;
  const newMessages = request.messages.slice(sentMessageCount);
  const input: Array<Record<string, unknown>> = [];

  for (const message of newMessages) {
    if (message.role === "system") {
      continue;
    }

    if (message.role === "user") {
      input.push({
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: getMessageText(message) }],
      });
      continue;
    }

    if (message.role === "tool") {
      if (!message.toolCallId) {
        continue;
      }
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: getMessageText(message),
      });
      continue;
    }

    if (message.role === "assistant" && !usePreviousResponseId) {
      const text = getMessageText(message);
      if (text.trim()) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }

      for (const toolCall of collectToolCalls(message.parts)) {
        input.push({
          type: "function_call",
          call_id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.argumentsText,
        });
      }
    }
  }

  return {
    input,
    sentMessageCount: request.messages.length,
    ...(usePreviousResponseId && state.previousResponseId
      ? { previousResponseId: state.previousResponseId }
      : {}),
  };
}

function buildOpenAIResponsesRequestBody(
  kind: ProviderKind,
  request: CompletionRequest,
  input: ReturnType<typeof buildOpenAIResponsesInput>,
  compatibility: OpenAIResponsesCompatibilityState,
): Record<string, unknown> {
  const tools = compatibility.supportsTools ? buildOpenAITools(request) : undefined;

  return {
    model: request.model,
    instructions: request.systemPrompt,
    input: input.input,
    stream: true,
    max_output_tokens: request.maxOutputTokens,
    temperature: request.temperature,
    ...(tools
      ? {
          tools,
          parallel_tool_calls: false,
        }
      : {}),
    ...(input.previousResponseId
      ? { previous_response_id: input.previousResponseId }
      : {}),
    ...(kind === "openai" && compatibility.supportsReasoning
      ? {
          reasoning: {
            effort: "medium",
            summary: "auto",
          },
        }
      : {}),
  };
}

function buildOpenAIResponsesProviderState(
  compatibility: OpenAIResponsesCompatibilityState,
  input: ReturnType<typeof buildOpenAIResponsesInput>,
  responseId: string | undefined,
): CompletionResult["providerState"] {
  const nextState: OpenAIResponseConversationState = {
    ...(compatibility.supportsPreviousResponseId && responseId
      ? {
          previousResponseId: responseId,
          sentMessageCount: input.sentMessageCount + 1,
        }
      : {}),
    ...(compatibility.supportsPreviousResponseId
      ? {}
      : { supportsPreviousResponseId: false }),
    ...(compatibility.supportsReasoning ? {} : { supportsReasoning: false }),
    ...(compatibility.supportsTools ? {} : { supportsTools: false }),
  };

  return Object.keys(nextState).length > 0
    ? (nextState as unknown as CompletionResult["providerState"])
    : undefined;
}

function buildOpenAIChatMessages(
  request: CompletionRequest,
): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];

  if (request.systemPrompt?.trim()) {
    messages.push({
      role: "system",
      content: request.systemPrompt,
    });
  }

  for (const message of request.messages) {
    if (message.role === "system") {
      continue;
    }

    if (message.role === "user") {
      messages.push({
        role: "user",
        content: getMessageText(message),
      });
      continue;
    }

    if (message.role === "tool") {
      messages.push({
        role: "tool",
        tool_call_id: message.toolCallId,
        content: getMessageText(message),
      });
      continue;
    }

    const text = getMessageText(message);
    const toolCalls = collectToolCalls(message.parts);
    messages.push({
      role: "assistant",
      content: text,
      ...(toolCalls.length
        ? {
            tool_calls: toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: call.argumentsText,
              },
            })),
          }
        : {}),
    });
  }

  return messages;
}

export async function* streamOpenAIResponses(
  kind: ProviderKind,
  client: OpenAI,
  request: CompletionRequest,
): AsyncGenerator<UnifiedStreamEvent, CompletionResult> {
  const toolCalls: UnifiedToolCall[] = [];
  const toolCallsByItemId = new Map<string, UnifiedToolCall>();
  let text = "";
  let reasoning = "";
  let usage = undefined as CompletionResult["usage"];
  let finishReason: string | undefined;
  let responseId: string | undefined;
  let compatibility = getResponsesCompatibilityState(kind, request);
  let input = buildOpenAIResponsesInput(request, {
    usePreviousResponseId: compatibility.supportsPreviousResponseId,
  });
  let stream: AsyncIterable<any> | undefined;

  while (!stream) {
    try {
      stream = (await (client.responses.create as any)(
        buildOpenAIResponsesRequestBody(kind, request, input, compatibility),
        request.signal ? { signal: request.signal } : undefined,
      )) as AsyncIterable<any>;
      break;
    } catch (error) {
      if (
        compatibility.supportsPreviousResponseId &&
        input.previousResponseId &&
        (isPreviousResponseIdUnsupported(error) ||
          (getErrorStatus(error) === 400 && hasCustomBaseUrl(request.profile)))
      ) {
        compatibility = {
          ...compatibility,
          supportsPreviousResponseId: false,
        };
        input = buildOpenAIResponsesInput(request, {
          usePreviousResponseId: false,
        });
        continue;
      }

      if (
        compatibility.supportsReasoning &&
        isReasoningUnsupported(error)
      ) {
        compatibility = {
          ...compatibility,
          supportsReasoning: false,
        };
        input = buildOpenAIResponsesInput(request, {
          usePreviousResponseId: compatibility.supportsPreviousResponseId,
        });
        continue;
      }

      if (
        compatibility.supportsTools &&
        request.tools?.length &&
        isToolCallingUnsupported(error)
      ) {
        compatibility = {
          ...compatibility,
          supportsTools: false,
        };
        input = buildOpenAIResponsesInput(request, {
          usePreviousResponseId: compatibility.supportsPreviousResponseId,
        });
        continue;
      }

      throw error;
    }
  }

  yield { type: "message-start" };

  for await (const event of stream) {
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      text += event.delta;
      yield { type: "text-delta", delta: event.delta };
      continue;
    }

    if (
      (event.type === "response.reasoning_text.delta" ||
        event.type === "response.reasoning_summary_text.delta") &&
      typeof event.delta === "string"
    ) {
      reasoning += event.delta;
      yield { type: "reasoning-delta", delta: event.delta };
      continue;
    }

    if (
      event.type === "response.output_item.added" &&
      event.item?.type === "function_call"
    ) {
      const call: UnifiedToolCall = {
        id: event.item.call_id,
        name: event.item.name,
        argumentsText: "",
      };
      toolCalls.push(call);
      if (typeof event.item.id === "string") {
        toolCallsByItemId.set(event.item.id, call);
      }
      yield { type: "tool-call", call };
      continue;
    }

    if (
      event.type === "response.function_call_arguments.delta" &&
      typeof event.item_id === "string" &&
      typeof event.delta === "string"
    ) {
      const call = toolCallsByItemId.get(event.item_id);
      if (call) {
        call.argumentsText += event.delta;
        yield {
          type: "tool-call-delta",
          id: call.id,
          name: call.name,
          delta: event.delta,
        };
      }
      continue;
    }

    if (event.type === "response.completed" && event.response) {
      responseId = event.response.id;
      usage = normalizeUsage(event.response.usage);
      finishReason =
        event.response.incomplete_details?.reason ??
        event.response.status ??
        undefined;
      if (usage) {
        yield { type: "usage", usage };
      }
    }
  }

  yield { type: "message-stop", finishReason };

  const providerState = buildOpenAIResponsesProviderState(
    compatibility,
    input,
    responseId,
  );

  return {
    assistantMessage: createAssistantMessage(text, reasoning, toolCalls),
    toolCalls,
    ...(finishReason ? { finishReason } : {}),
    ...(usage ? { usage } : {}),
    ...(providerState ? { providerState } : {}),
  };
}

export async function* streamOpenAIChatCompletions(
  client: OpenAI,
  request: CompletionRequest,
): AsyncGenerator<UnifiedStreamEvent, CompletionResult> {
  const toolCallsByIndex = new Map<number, UnifiedToolCall>();
  let finishReason: string | undefined;
  let text = "";
  let reasoning = "";

  const stream = (await (client.chat.completions.create as any)(
    {
      model: request.model,
      messages: buildOpenAIChatMessages(request),
      stream: true,
      temperature: request.temperature,
      max_tokens: request.maxOutputTokens,
      tools: request.tools?.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })),
      tool_choice: request.tools?.length ? "auto" : undefined,
      parallel_tool_calls: false,
    },
    request.signal ? { signal: request.signal } : undefined,
  )) as AsyncIterable<any>;

  yield { type: "message-start" };

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    const delta = choice?.delta;

    if (typeof delta?.content === "string") {
      text += delta.content;
      yield {
        type: "text-delta",
        delta: delta.content,
      };
    }

    const rawReasoning = delta?.reasoning_content ?? delta?.reasoning;
    if (typeof rawReasoning === "string" && rawReasoning) {
      reasoning += rawReasoning;
      yield {
        type: "reasoning-delta",
        delta: rawReasoning,
      };
    }

    if (Array.isArray(rawReasoning)) {
      for (const part of rawReasoning) {
        const deltaText =
          typeof part === "string"
            ? part
            : typeof part?.text === "string"
              ? part.text
              : undefined;
        if (deltaText) {
          reasoning += deltaText;
          yield {
            type: "reasoning-delta",
            delta: deltaText,
          };
        }
      }
    }

    if (Array.isArray(delta?.tool_calls)) {
      for (const rawToolCall of delta.tool_calls) {
        const index = typeof rawToolCall.index === "number" ? rawToolCall.index : 0;
        let call = toolCallsByIndex.get(index);
        if (!call) {
          call = {
            id: rawToolCall.id ?? `tool-${index}`,
            name: rawToolCall.function?.name ?? "tool",
            argumentsText: "",
          };
          toolCallsByIndex.set(index, call);
          yield { type: "tool-call", call };
        }

        if (typeof rawToolCall.id === "string") {
          call.id = rawToolCall.id;
        }
        if (typeof rawToolCall.function?.name === "string") {
          call.name = rawToolCall.function.name;
        }
        if (typeof rawToolCall.function?.arguments === "string") {
          call.argumentsText += rawToolCall.function.arguments;
          yield {
            type: "tool-call-delta",
            id: call.id,
            name: call.name,
            delta: rawToolCall.function.arguments,
          };
        }
      }
    }

    if (typeof choice?.finish_reason === "string") {
      finishReason = choice.finish_reason;
    }

    const usage = normalizeUsage(chunk.usage);
    if (usage) {
      yield { type: "usage", usage };
    }
  }

  const toolCalls = [...toolCallsByIndex.values()];
  yield { type: "message-stop", finishReason };

  return {
    assistantMessage: createAssistantMessage(text, reasoning, toolCalls),
    toolCalls,
    ...(finishReason ? { finishReason } : {}),
  };
}

export function isLikelyResponsesUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  const raw = error as
    | {
        status?: number | undefined;
        code?: string | undefined;
        type?: string | undefined;
        name?: string | undefined;
      }
    | undefined;
  const status = raw?.status;
  const code = raw?.code?.toLowerCase();
  const type = raw?.type?.toLowerCase();
  const name = raw?.name?.toLowerCase();

  const hintsText = [normalized, code, type, name].filter(Boolean).join(" ");
  return (
    status === 404 ||
    (status === 403 &&
      (hintsText.includes("blocked") ||
        hintsText.includes("forbidden") ||
        hintsText.includes("permissiondenied") ||
        hintsText.includes("permission denied"))) ||
    normalized.includes("unknown parameter") ||
    normalized.includes("unknown request url") ||
    normalized.includes("not found") ||
    normalized.includes("unsupported") ||
    normalized.includes("responses") ||
    normalized.includes("404") ||
    normalized.includes("403") ||
    normalized.includes("forbidden") ||
    normalized.includes("blocked") ||
    normalized.includes("permissiondenied") ||
    normalized.includes("permission denied")
  );
}

export function buildOpenAICompatibleValidationHint(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Connected check was partial: ${message}. You can still continue and add models manually if this endpoint does not expose /models.`;
}
