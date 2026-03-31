import {
  BedrockClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
} from "@aws-sdk/client-bedrock";
import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
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

function applyAwsProfile(profile: ResolvedProviderProfile): void {
  if (profile.meta.awsProfile?.trim()) {
    process.env.AWS_PROFILE = profile.meta.awsProfile.trim();
  }
}

function buildAwsCredentials(profile: ResolvedProviderProfile) {
  if (!profile.secrets.accessKeyId || !profile.secrets.secretAccessKey) {
    return undefined;
  }

  return {
    accessKeyId: profile.secrets.accessKeyId,
    secretAccessKey: profile.secrets.secretAccessKey,
    ...(profile.secrets.sessionToken
      ? { sessionToken: profile.secrets.sessionToken }
      : {}),
  };
}

function createBedrockControlClient(
  profile: ResolvedProviderProfile,
): BedrockClient {
  applyAwsProfile(profile);
  if (!profile.meta.region?.trim()) {
    throw new UserError("Bedrock profiles need a region.");
  }

  const credentials = buildAwsCredentials(profile);
  return new BedrockClient({
    region: profile.meta.region,
    ...(credentials ? { credentials } : {}),
  });
}

function createBedrockRuntimeClient(
  profile: ResolvedProviderProfile,
): BedrockRuntimeClient {
  applyAwsProfile(profile);
  if (!profile.meta.region?.trim()) {
    throw new UserError("Bedrock profiles need a region.");
  }

  const credentials = buildAwsCredentials(profile);
  return new BedrockRuntimeClient({
    region: profile.meta.region,
    ...(credentials ? { credentials } : {}),
  });
}

function buildBedrockMessages(
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
            toolResult: {
              toolUseId: message.toolCallId,
              content: [{ text: getMessageText(message) }],
              ...(message.isError ? { status: "error" } : {}),
            },
          },
        ],
      });
      continue;
    }

    if (message.role === "assistant") {
      messages.push({
        role: "assistant",
        content: [
          ...collectToolCalls(message.parts).map((call) => ({
            toolUse: {
              toolUseId: call.id,
              name: call.name,
              input: tryParseToolArguments(call.argumentsText),
            },
          })),
          ...(getMessageText(message).trim()
            ? [{ text: getMessageText(message) }]
            : []),
        ],
      });
      continue;
    }

    messages.push({
      role: "user",
      content: [{ text: getMessageText(message) }],
    });
  }

  return messages;
}

export class BedrockProviderAdapter implements ProviderAdapter {
  readonly kind = "bedrock" as const;
  readonly displayName = "Amazon Bedrock";

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
      const client = createBedrockControlClient(profile);
      await client.send(new ListFoundationModelsCommand({}));
      return {
        ok: true,
        message: "Bedrock credentials and region look good.",
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async listModels(profile: ResolvedProviderProfile): Promise<ModelDescriptor[]> {
    const client = createBedrockControlClient(profile);
    const [foundationModels, inferenceProfiles] = await Promise.allSettled([
      client.send(new ListFoundationModelsCommand({})),
      client.send(new ListInferenceProfilesCommand({})),
    ]);

    const models: ModelDescriptor[] = [];

    if (foundationModels.status === "fulfilled") {
      for (const model of foundationModels.value.modelSummaries ?? []) {
        if (!model.modelId) {
          continue;
        }
        const raw: Record<string, string | boolean> = {};
        if (model.providerName) {
          raw.providerName = model.providerName;
        }
        if (typeof model.responseStreamingSupported === "boolean") {
          raw.responseStreamingSupported = model.responseStreamingSupported;
        }
        models.push(
          toModelDescriptor(
            model.modelId,
            model.modelName ?? model.modelId,
            this.kind,
            "remote",
            Object.keys(raw).length ? raw : undefined,
          ),
        );
      }
    }

    if (inferenceProfiles.status === "fulfilled") {
      for (const summary of inferenceProfiles.value.inferenceProfileSummaries ?? []) {
        if (!summary.inferenceProfileId) {
          continue;
        }
        models.push(
          toModelDescriptor(
            summary.inferenceProfileId,
            summary.inferenceProfileName ?? summary.inferenceProfileId,
            this.kind,
            "remote",
            {
              type: "inference-profile",
            },
          ),
        );
      }
    }

    return models;
  }

  async *streamResponse(
    request: CompletionRequest,
  ): AsyncGenerator<UnifiedStreamEvent, CompletionResult> {
    const client = createBedrockRuntimeClient(request.profile);
    const toolCalls: UnifiedToolCall[] = [];
    const blockMap = new Map<number, UnifiedToolCall>();
    let text = "";
    let reasoning = "";
    let usage: CompletionResult["usage"];
    let finishReason: string | undefined;

    const response = await client.send(
      new ConverseStreamCommand({
        modelId: request.model,
        messages: buildBedrockMessages(request) as never,
        ...(request.systemPrompt?.trim()
          ? { system: [{ text: request.systemPrompt }] }
          : {}),
        inferenceConfig: {
          maxTokens: request.maxOutputTokens,
          temperature: request.temperature,
        },
        ...(request.tools?.length
          ? {
              toolConfig: {
                tools: request.tools.map((tool) => ({
                  toolSpec: {
                    name: tool.name,
                    description: tool.description,
                    inputSchema: {
                      json: tool.inputSchema,
                    },
                  },
                })),
              },
            }
          : {}),
      } as never),
    );

    yield { type: "message-start" };

    for await (const chunk of response.stream ?? []) {
      if (chunk.contentBlockStart?.start?.toolUse) {
        const toolUse = chunk.contentBlockStart.start.toolUse;
        const call: UnifiedToolCall = {
          id:
            toolUse.toolUseId ??
            `tool-${chunk.contentBlockStart.contentBlockIndex ?? 0}`,
          name: toolUse.name ?? "tool",
          argumentsText: "",
        };
        const index = chunk.contentBlockStart.contentBlockIndex ?? 0;
        blockMap.set(index, call);
        toolCalls.push(call);
        yield { type: "tool-call", call };
        continue;
      }

      if (chunk.contentBlockDelta?.delta?.text) {
        text += chunk.contentBlockDelta.delta.text;
        yield {
          type: "text-delta",
          delta: chunk.contentBlockDelta.delta.text,
        };
        continue;
      }

      if (chunk.contentBlockDelta?.delta?.reasoningContent?.text) {
        reasoning += chunk.contentBlockDelta.delta.reasoningContent.text;
        yield {
          type: "reasoning-delta",
          delta: chunk.contentBlockDelta.delta.reasoningContent.text,
        };
        continue;
      }

      if (chunk.contentBlockDelta?.delta?.toolUse?.input) {
        const index = chunk.contentBlockDelta.contentBlockIndex ?? 0;
        const call = blockMap.get(index);
        if (call) {
          call.argumentsText += chunk.contentBlockDelta.delta.toolUse.input;
          yield {
            type: "tool-call-delta",
            id: call.id,
            name: call.name,
            delta: chunk.contentBlockDelta.delta.toolUse.input,
          };
        }
        continue;
      }

      if (chunk.metadata?.usage) {
        usage = normalizeUsage({
          inputTokens: chunk.metadata.usage.inputTokens,
          outputTokens: chunk.metadata.usage.outputTokens,
          totalTokens: chunk.metadata.usage.totalTokens,
        });
        if (usage) {
          yield { type: "usage", usage };
        }
        continue;
      }

      if (chunk.messageStop?.stopReason) {
        finishReason = chunk.messageStop.stopReason;
      }

      if (
        chunk.internalServerException ||
        chunk.modelStreamErrorException ||
        chunk.validationException ||
        chunk.throttlingException ||
        chunk.serviceUnavailableException
      ) {
        throw new Error(
          JSON.stringify(
            chunk.internalServerException ??
              chunk.modelStreamErrorException ??
              chunk.validationException ??
              chunk.throttlingException ??
              chunk.serviceUnavailableException,
          ),
        );
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
