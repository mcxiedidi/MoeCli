import Anthropic from "@anthropic-ai/sdk";
import type {
  CompletionRequest,
  CompletionResult,
  ModelDescriptor,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderValidationResult,
  ResolvedProviderProfile,
  UnifiedStreamEvent,
  UnifiedToolCall,
} from "./types.js";
import {
  collectReasoning,
  collectText,
  collectToolCalls,
  createAssistantMessage,
  getMessageText,
  normalizeUsage,
  toModelDescriptor,
  tryParseToolArguments,
} from "./helpers.js";
import { getSuggestedModels } from "../config/providerDefaults.js";
import { UserError } from "../utils/errors.js";

const capabilities: ProviderCapabilities = {
  streaming: true,
  toolCalling: true,
  modelListing: true,
  reasoningDeltas: true,
  toolCallDeltas: true,
};

function createAnthropicClient(profile: ResolvedProviderProfile): Anthropic {
  if (!profile.secrets.apiKey?.trim()) {
    throw new UserError(`Profile "${profile.meta.name}" is missing an API key.`);
  }

  return new Anthropic({
    apiKey: profile.secrets.apiKey,
    ...(profile.meta.baseUrl ? { baseURL: profile.meta.baseUrl } : {}),
    defaultHeaders: profile.meta.extraHeaders,
  });
}

function buildAnthropicMessages(
  request: CompletionRequest,
): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];

  for (const message of request.messages) {
    if (message.role === "system") {
      continue;
    }

    if (message.role === "tool") {
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId,
            content: getMessageText(message),
            ...(message.isError ? { is_error: true } : {}),
          },
        ],
      });
      continue;
    }

    if (message.role === "user") {
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: getMessageText(message),
          },
        ],
      });
      continue;
    }

    const content: Array<Record<string, unknown>> = [];
    const reasoning = collectReasoning(message.parts);
    if (reasoning.trim()) {
      content.push({
        type: "thinking",
        thinking: reasoning,
        signature: "",
      });
    }
    const text = collectText(message.parts);
    if (text.trim()) {
      content.push({
        type: "text",
        text,
      });
    }
    for (const call of collectToolCalls(message.parts)) {
      content.push({
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: tryParseToolArguments(call.argumentsText),
      });
    }
    messages.push({
      role: "assistant",
      content,
    });
  }

  return messages;
}

export class AnthropicProviderAdapter implements ProviderAdapter {
  readonly kind = "anthropic" as const;
  readonly displayName = "Anthropic Messages";

  getCapabilities(): ProviderCapabilities {
    return capabilities;
  }

  getSuggestedModels(profile: ResolvedProviderProfile): ModelDescriptor[] {
    return getSuggestedModels(profile);
  }

  async validateProfile(
    profile: ResolvedProviderProfile,
  ): Promise<ProviderValidationResult> {
    try {
      const client = createAnthropicClient(profile);
      const page = await client.beta.models.list();
      for await (const _model of page) {
        break;
      }
      return {
        ok: true,
        message: "Anthropic connection looks good.",
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async listModels(profile: ResolvedProviderProfile): Promise<ModelDescriptor[]> {
    const client = createAnthropicClient(profile);
    const page = await client.beta.models.list();
    const models: ModelDescriptor[] = [];
    for await (const model of page) {
      models.push(
        toModelDescriptor(model.id, model.display_name, this.kind, "remote", {
          id: model.id,
          display_name: model.display_name,
          created_at: model.created_at,
        }),
      );
    }
    return models;
  }

  async *streamResponse(
    request: CompletionRequest,
  ): AsyncGenerator<UnifiedStreamEvent, CompletionResult> {
    const client = createAnthropicClient(request.profile);
    const toolCalls: UnifiedToolCall[] = [];
    const toolCallsByIndex = new Map<number, UnifiedToolCall>();
    let text = "";
    let reasoning = "";
    let finishReason: string | undefined;
    let usage: CompletionResult["usage"];

    const stream = await client.messages.create(
      {
        model: request.model,
        max_tokens: request.maxOutputTokens ?? 4096,
        stream: true,
        messages: buildAnthropicMessages(request) as never,
        ...(typeof request.temperature === "number"
          ? { temperature: request.temperature }
          : {}),
        ...(request.systemPrompt
          ? { system: request.systemPrompt }
          : {}),
        ...(request.tools?.length
          ? {
              tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema as {
                  type: "object";
                  [key: string]: unknown;
                },
              })),
            }
          : {}),
      },
      request.signal ? { signal: request.signal } : undefined,
    );

    yield { type: "message-start" };

    for await (const event of stream as AsyncIterable<any>) {
      if (
        event.type === "content_block_start" &&
        event.content_block?.type === "tool_use"
      ) {
        const call: UnifiedToolCall = {
          id: event.content_block.id,
          name: event.content_block.name,
          argumentsText: "",
        };
        toolCalls.push(call);
        toolCallsByIndex.set(event.index, call);
        yield { type: "tool-call", call };
        continue;
      }

      if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
        text += event.delta.text;
        yield { type: "text-delta", delta: event.delta.text };
        continue;
      }

      if (
        event.type === "content_block_delta" &&
        event.delta?.type === "thinking_delta"
      ) {
        reasoning += event.delta.thinking;
        yield { type: "reasoning-delta", delta: event.delta.thinking };
        continue;
      }

      if (
        event.type === "content_block_delta" &&
        event.delta?.type === "input_json_delta"
      ) {
        const call = toolCallsByIndex.get(event.index);
        if (call) {
          call.argumentsText += event.delta.partial_json;
          yield {
            type: "tool-call-delta",
            id: call.id,
            name: call.name,
            delta: event.delta.partial_json,
          };
        }
        continue;
      }

      if (event.type === "message_delta") {
        finishReason = event.delta?.stop_reason ?? undefined;
        usage = normalizeUsage(event.usage);
        if (usage) {
          yield { type: "usage", usage };
        }
      }
    }

    yield { type: "message-stop", finishReason };

    return {
      assistantMessage: createAssistantMessage(text, reasoning, toolCalls),
      toolCalls,
      ...(finishReason ? { finishReason } : {}),
      ...(usage ? { usage } : {}),
    };
  }
}
