import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { AppSettingsSchema, type AppSettings, type MutableSettingsUpdate } from "./types.js";
import { ensureAppDirs, getSettingsPath } from "./paths.js";
import type {
  ModelDescriptor,
  ProviderProfileMeta,
  ResolvedProviderProfile,
} from "../providers/types.js";
import { getProfileSecrets } from "./secrets.js";
import { getSuggestedModels } from "./providerDefaults.js";

function writeSettings(settings: AppSettings): void {
  ensureAppDirs();
  writeFileSync(getSettingsPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  try {
    chmodSync(getSettingsPath(), 0o600);
  } catch {
    // Ignore chmod errors on unsupported platforms.
  }
}

export function getSettings(): AppSettings {
  ensureAppDirs();

  if (!existsSync(getSettingsPath())) {
    const settings = AppSettingsSchema.parse({});
    writeSettings(settings);
    return settings;
  }

  const parsed = AppSettingsSchema.safeParse(
    JSON.parse(readFileSync(getSettingsPath(), "utf8")),
  );
  if (!parsed.success) {
    const settings = AppSettingsSchema.parse({});
    writeSettings(settings);
    return settings;
  }
  return parsed.data;
}

export function saveSettings(settings: AppSettings): void {
  writeSettings(AppSettingsSchema.parse(settings));
}

export function updateSettings(
  updater: (current: AppSettings) => AppSettings,
): AppSettings {
  const next = updater(getSettings());
  saveSettings(next);
  return next;
}

export function patchSettings(patch: MutableSettingsUpdate): AppSettings {
  return updateSettings((current) => ({
    ...current,
    ...patch,
  }));
}

export function createProfileId(): string {
  return randomUUID();
}

export function getProfileById(profileId: string): ProviderProfileMeta | undefined {
  return getSettings().providerProfiles.find((profile) => profile.id === profileId);
}

export function getProfileByName(name: string): ProviderProfileMeta | undefined {
  const normalized = name.trim().toLowerCase();
  return getSettings().providerProfiles.find(
    (profile) => profile.name.trim().toLowerCase() === normalized,
  );
}

export function upsertProfile(profile: ProviderProfileMeta): AppSettings {
  return updateSettings((current) => {
    const existingIndex = current.providerProfiles.findIndex(
      (entry) => entry.id === profile.id,
    );
    const providerProfiles = [...current.providerProfiles];

    if (existingIndex >= 0) {
      providerProfiles[existingIndex] = profile;
    } else {
      providerProfiles.push(profile);
    }

    return {
      ...current,
      providerProfiles,
      activeProfileId: current.activeProfileId ?? profile.id,
    };
  });
}

export function deleteProfile(profileId: string): AppSettings {
  return updateSettings((current) => {
    const providerProfiles = current.providerProfiles.filter(
      (profile) => profile.id !== profileId,
    );
    const manualModelsByProfile = { ...current.manualModelsByProfile };
    const cachedModelsByProfile = { ...current.cachedModelsByProfile };
    const profileDefaults = { ...current.profileDefaults };

    delete manualModelsByProfile[profileId];
    delete cachedModelsByProfile[profileId];
    delete profileDefaults[profileId];

    return {
      ...current,
      providerProfiles,
      manualModelsByProfile,
      cachedModelsByProfile,
      profileDefaults,
      activeProfileId:
        current.activeProfileId === profileId
          ? providerProfiles[0]?.id
          : current.activeProfileId,
    };
  });
}

export function setActiveProfile(profileId: string): AppSettings {
  return patchSettings({ activeProfileId: profileId });
}

export function setCachedModels(
  profileId: string,
  models: ModelDescriptor[],
): AppSettings {
  return updateSettings((current) => ({
    ...current,
    cachedModelsByProfile: {
      ...current.cachedModelsByProfile,
      [profileId]: models.map((model) => ({
        id: model.id,
        label: model.label,
        provider: model.provider,
        source: model.source,
        supportsTools: model.supportsTools,
        supportsReasoning: model.supportsReasoning,
        contextWindow: model.contextWindow,
      })),
    },
  }));
}

export function setManualModels(
  profileId: string,
  models: ModelDescriptor[],
): AppSettings {
  return updateSettings((current) => ({
    ...current,
    manualModelsByProfile: {
      ...current.manualModelsByProfile,
      [profileId]: models.map((model) => ({
        id: model.id,
        label: model.label,
        provider: model.provider,
        source: "manual",
        supportsTools: model.supportsTools,
        supportsReasoning: model.supportsReasoning,
        contextWindow: model.contextWindow,
      })),
    },
  }));
}

export function setDefaultModel(profileId: string, modelId: string): AppSettings {
  return updateSettings((current) => ({
    ...current,
    profileDefaults: {
      ...current.profileDefaults,
      [profileId]: {
        ...current.profileDefaults[profileId],
        defaultModel: modelId,
      },
    },
  }));
}

export function setTransportMode(
  profileId: string,
  transportMode: "auto" | "responses" | "chat",
): AppSettings {
  return updateSettings((current) => ({
    ...current,
    profileDefaults: {
      ...current.profileDefaults,
      [profileId]: {
        ...current.profileDefaults[profileId],
        transportMode,
      },
    },
  }));
}

export function getProfileDefaultModel(profileId: string): string | undefined {
  return getSettings().profileDefaults[profileId]?.defaultModel;
}

export function getProfileTransportMode(
  profileId: string,
): "auto" | "responses" | "chat" {
  return getSettings().profileDefaults[profileId]?.transportMode ?? "auto";
}

export function getManualModels(profileId: string): ModelDescriptor[] {
  return (
    getSettings().manualModelsByProfile[profileId]?.map((model) => ({
      ...model,
      raw: undefined,
    })) ?? []
  );
}

export function getCachedModels(profileId: string): ModelDescriptor[] {
  return (
    getSettings().cachedModelsByProfile[profileId]?.map((model) => ({
      ...model,
      raw: undefined,
    })) ?? []
  );
}

export function getModelCatalog(
  profile: ResolvedProviderProfile,
): ModelDescriptor[] {
  const cached = getCachedModels(profile.meta.id);
  if (cached.length > 0) {
    return cached;
  }

  const manual = getManualModels(profile.meta.id);
  if (manual.length > 0) {
    return manual;
  }

  return getSuggestedModels(profile);
}

export function resolveModelForProfile(
  profile: ResolvedProviderProfile,
  requestedModel?: string,
): string | undefined {
  if (requestedModel?.trim()) {
    return requestedModel.trim();
  }

  const defaultModel = getProfileDefaultModel(profile.meta.id);
  if (defaultModel?.trim()) {
    return defaultModel.trim();
  }

  return getModelCatalog(profile)[0]?.id;
}

export async function resolveActiveProfile(
  requestedProfileName?: string,
): Promise<ResolvedProviderProfile | null> {
  const settings = getSettings();
  const profile =
    (requestedProfileName ? getProfileByName(requestedProfileName) : undefined) ??
    settings.providerProfiles.find(
      (entry) => entry.id === settings.activeProfileId && entry.enabled,
    ) ??
    settings.providerProfiles.find((entry) => entry.enabled);

  if (!profile) {
    return null;
  }

  return {
    meta: profile,
    secrets: await getProfileSecrets(profile.id),
  };
}
