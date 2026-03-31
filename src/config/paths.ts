import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  APP_AGENTS_DIR,
  APP_CACHE_DIR,
  APP_CONFIG_FILE,
  APP_DIR_NAME,
  APP_SECRETS_FILE,
  APP_WORKTREE_DIR,
} from "../utils/constants.js";

export function getAppHomeDir(): string {
  return process.env.MOECLI_HOME || join(homedir(), APP_DIR_NAME);
}

export function ensureAppDirs(): void {
  const dirs = [
    getAppHomeDir(),
    getCacheDir(),
    getAgentsDir(),
    getWorktreesDir(),
  ];

  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }
}

export function getSettingsPath(): string {
  return join(getAppHomeDir(), APP_CONFIG_FILE);
}

export function getSecretsPath(): string {
  return join(getAppHomeDir(), APP_SECRETS_FILE);
}

export function getCacheDir(): string {
  return join(getAppHomeDir(), APP_CACHE_DIR);
}

export function getSessionsCacheDir(): string {
  return join(getCacheDir(), "sessions");
}

export function getSessionDir(sessionId: string): string {
  return join(getSessionsCacheDir(), sessionId);
}

export function getSessionMemoryPath(sessionId: string): string {
  return join(getSessionDir(sessionId), "session-memory.md");
}

export function getAgentsDir(): string {
  return join(getAppHomeDir(), APP_AGENTS_DIR);
}

export function getWorktreesDir(): string {
  return join(getAppHomeDir(), APP_WORKTREE_DIR);
}

export function getAgentDir(agentId: string): string {
  return join(getAgentsDir(), agentId);
}
