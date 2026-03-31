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
import { getProfileTransportMode, setTransportMode } from "../config/settings.js";
import {
  buildOpenAICompatibleValidationHint,
  createOpenAIClient,
  isLikelyResponsesUnsupported,
  streamOpenAIChatCompletions,
  streamOpenAIResponses,
} from "./openaiCommon.js";
import { toModelDescriptor } from "./helpers.js";
import { UserError } from "../utils/errors.js";

const capabilities: ProviderCapabilities = {
  streaming: true,
  toolCalling: true,
  modelListing: true,
  reasoningDeltas: false,
  toolCallDeltas: true,
};

export class OpenAICompatibleProviderAdapter implements ProviderAdapter {
  readonly kind = "openai-compatible" as const;
  readonly displayName = "OpenAI Compatible";

  getCapabilities(): ProviderCapabilities {
    return capabilities;
  }

  getSuggestedModels(profile: ResolvedProviderProfile): ModelDescriptor[] {
    return getSuggestedModels(profile);
  }

  async validateProfile(
    profile: ResolvedProviderProfile,
  ): Promise<ProviderValidationResult> {
    if (!profile.meta.baseUrl?.trim()) {
      return {
        ok: false,
        message: "OpenAI Compatible profiles need a base URL.",
      };
    }

    try {
      const client = createOpenAIClient(profile);
      const page = await client.models.list();
      for await (const _model of page) {
        break;
      }
      return {
        ok: true,
        message: "Compatible endpoint responded to /models.",
      };
    } catch (error) {
      return {
        ok: true,
        message: buildOpenAICompatibleValidationHint(error),
      };
    }
  }

  async listModels(profile: ResolvedProviderProfile): Promise<ModelDescriptor[]> {
    if (!profile.meta.baseUrl?.trim()) {
      throw new UserError("This profile is missing a base URL.");
    }

    const client = createOpenAIClient(profile);
    const page = await client.models.list();
    const models: ModelDescriptor[] = [];
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
    const transportMode = getProfileTransportMode(request.profile.meta.id);
    const client = createOpenAIClient(request.profile);

    if (transportMode === "chat") {
      return yield* streamOpenAIChatCompletions(client, request);
    }

    if (transportMode === "responses") {
      return yield* streamOpenAIResponses(this.kind, client, request);
    }

    try {
      return yield* streamOpenAIResponses(this.kind, client, request);
    } catch (error) {
      if (!isLikelyResponsesUnsupported(error)) {
        throw error;
      }
      setTransportMode(request.profile.meta.id, "chat");
      return yield* streamOpenAIChatCompletions(client, request);
    }
  }
}
