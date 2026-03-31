import type {
  ModelDescriptor,
  ProviderKind,
  ResolvedProviderProfile,
} from "../providers/types.js";

const DEFAULT_MODELS: Record<ProviderKind, string[]> = {
  openai: ["gpt-5", "gpt-5-mini", "gpt-4.1"],
  "openai-compatible": ["gpt-5", "gpt-4.1", "gpt-4o"],
  anthropic: [
    "claude-sonnet-4-5",
    "claude-sonnet-4",
    "claude-3-5-haiku-latest",
  ],
  bedrock: [
    "anthropic.claude-3-5-sonnet-20241022-v2:0",
    "anthropic.claude-3-5-haiku-20241022-v1:0",
  ],
  gemini: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
};

export function getSuggestedModels(
  profile: ResolvedProviderProfile,
): ModelDescriptor[] {
  return (DEFAULT_MODELS[profile.meta.kind] ?? []).map((id) => ({
    id,
    label: id,
    provider: profile.meta.kind,
    source: "suggested",
  }));
}
