import type {
  ProviderAdapter,
  ProviderKind,
  ResolvedProviderProfile,
} from "./types.js";
import { AnthropicProviderAdapter } from "./anthropic.js";
import { BedrockProviderAdapter } from "./bedrock.js";
import { GeminiProviderAdapter } from "./gemini.js";
import { OpenAIProviderAdapter } from "./openai.js";
import { OpenAICompatibleProviderAdapter } from "./openaiCompatible.js";
import { getModelCatalog } from "../config/settings.js";

const adapters: Record<ProviderKind, ProviderAdapter> = {
  openai: new OpenAIProviderAdapter(),
  "openai-compatible": new OpenAICompatibleProviderAdapter(),
  anthropic: new AnthropicProviderAdapter(),
  bedrock: new BedrockProviderAdapter(),
  gemini: new GeminiProviderAdapter(),
};

export function getProviderAdapter(kind: ProviderKind): ProviderAdapter {
  return adapters[kind];
}

export function listProviderAdapters(): ProviderAdapter[] {
  return Object.values(adapters);
}

export function getAvailableModels(profile: ResolvedProviderProfile) {
  return getModelCatalog(profile);
}
