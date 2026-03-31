import { z } from "zod";
import type {
  OpenAICompatibleTransportMode,
  ProviderProfileMeta,
} from "../providers/types.js";

export const ProviderProfileMetaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum([
    "openai",
    "openai-compatible",
    "anthropic",
    "bedrock",
    "gemini",
  ]),
  enabled: z.boolean().default(true),
  createdAt: z.string(),
  updatedAt: z.string(),
  baseUrl: z.string().optional(),
  region: z.string().optional(),
  projectId: z.string().optional(),
  awsProfile: z.string().optional(),
  apiVersion: z.string().optional(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
});

export const ModelDescriptorSnapshotSchema = z.object({
  id: z.string(),
  label: z.string(),
  provider: z.enum([
    "openai",
    "openai-compatible",
    "anthropic",
    "bedrock",
    "gemini",
  ]),
  source: z.enum(["remote", "manual", "suggested"]),
  supportsTools: z.boolean().optional(),
  supportsReasoning: z.boolean().optional(),
  contextWindow: z.number().optional(),
});

export type ModelDescriptorSnapshot = z.infer<
  typeof ModelDescriptorSnapshotSchema
>;

export const ProfileDefaultSchema = z.object({
  defaultModel: z.string().optional(),
  transportMode: z.enum(["auto", "responses", "chat"]).optional(),
});

export interface ProfileDefaults {
  defaultModel?: string;
  transportMode?: OpenAICompatibleTransportMode;
}

export const AppSettingsSchema = z.object({
  providerProfiles: z.array(ProviderProfileMetaSchema).default([]),
  activeProfileId: z.string().optional(),
  manualModelsByProfile: z
    .record(z.string(), z.array(ModelDescriptorSnapshotSchema))
    .default({}),
  cachedModelsByProfile: z
    .record(z.string(), z.array(ModelDescriptorSnapshotSchema))
    .default({}),
  profileDefaults: z.record(z.string(), ProfileDefaultSchema).default({}),
  browser: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({ enabled: true }),
  search: z
    .object({
      enabled: z.boolean().default(true),
      endpoint: z
        .string()
        .default("https://uapis.cn/api/v1/search/aggregate"),
      headerName: z.string().default("Authorization"),
      headerPrefix: z.string().default("Bearer "),
      defaultFetchFull: z.boolean().default(false),
      defaultSort: z.enum(["relevance", "date"]).default("relevance"),
      defaultTimeRange: z
        .enum(["day", "week", "month", "year"])
        .optional(),
      defaultSite: z.string().optional(),
      defaultFiletype: z.string().optional(),
      docsUrl: z
        .string()
        .default("https://uapis.cn/docs/api-reference/post-search-aggregate"),
    })
    .default({
      enabled: true,
      endpoint: "https://uapis.cn/api/v1/search/aggregate",
      headerName: "Authorization",
      headerPrefix: "Bearer ",
      defaultFetchFull: false,
      defaultSort: "relevance",
      docsUrl: "https://uapis.cn/docs/api-reference/post-search-aggregate",
    }),
  agents: z
    .object({
      defaultMode: z
        .enum(["background", "worktree", "tmux"])
        .default("background"),
      maxConcurrent: z.number().int().positive().default(4),
    })
    .default({
      defaultMode: "background",
      maxConcurrent: 4,
    }),
});

export type AppSettings = z.infer<typeof AppSettingsSchema>;

export interface MutableSettingsUpdate {
  providerProfiles?: ProviderProfileMeta[];
  activeProfileId?: string;
  manualModelsByProfile?: AppSettings["manualModelsByProfile"];
  cachedModelsByProfile?: AppSettings["cachedModelsByProfile"];
  profileDefaults?: AppSettings["profileDefaults"];
  browser?: AppSettings["browser"];
  search?: AppSettings["search"];
  agents?: AppSettings["agents"];
}
