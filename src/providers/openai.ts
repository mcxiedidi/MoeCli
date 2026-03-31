import type {
  CompletionRequest,
  CompletionResult,
  ModelDescriptor,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderValidationResult,
  ResolvedProviderProfile,
  UnifiedStreamEvent,
} from "./types.js";
import { getSuggestedModels } from "../config/providerDefaults.js";
import { createOpenAIClient, streamOpenAIResponses } from "./openaiCommon.js";
import { toModelDescriptor } from "./helpers.js";

const capabilities: ProviderCapabilities = {
  streaming: true,
  toolCalling: true,
  modelListing: true,
  reasoningDeltas: true,
  toolCallDeltas: true,
};

export class OpenAIProviderAdapter implements ProviderAdapter {
  readonly kind = "openai" as const;
  readonly displayName = "OpenAI Responses";

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
      const client = createOpenAIClient(profile);
      const page = await client.models.list();
      for await (const _model of page) {
        break;
      }
      return {
        ok: true,
        message: "OpenAI connection looks good.",
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async listModels(profile: ResolvedProviderProfile): Promise<ModelDescriptor[]> {
    const client = createOpenAIClient(profile);
    const models: ModelDescriptor[] = [];
    const page = await client.models.list();

    for await (const model of page) {
      models.push(
        toModelDescriptor(model.id, model.id, this.kind, "remote", {
          id: model.id,
          created: model.created,
          owned_by: model.owned_by,
        }),
      );
    }

    return models;
  }

  async *streamResponse(
    request: CompletionRequest,
  ): AsyncGenerator<UnifiedStreamEvent, CompletionResult> {
    const client = createOpenAIClient(request.profile);
    return yield* streamOpenAIResponses(this.kind, client, request);
  }
}
