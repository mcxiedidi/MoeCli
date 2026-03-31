import { dirname } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type { InteractionMode } from "../cli/interactionMode.js";
import { getModelCatalog } from "../config/settings.js";
import { createUserMessage, getMessageText } from "../providers/helpers.js";
import type {
  ProviderKind,
  ResolvedProviderProfile,
  SessionMessage,
} from "../providers/types.js";
import type { TaskModeState } from "./taskTypes.js";
import { getSessionMemoryPath } from "../config/paths.js";

export type CompressionTrigger = "proactive" | "overflow-retry";

export interface ContextBudget {
  modelContextWindow: number;
  reservedSummaryOutputTokens: number;
  effectiveContextWindow: number;
  autoCompactThreshold: number;
  recentTailTokenBudget: number;
  isModelContextWindowKnown: boolean;
}

export interface CompactionStats {
  autoCompactEnabled: boolean;
  compressionCount: number;
  archivedMessageCount: number;
  lastCompressionReason?: CompressionTrigger | undefined;
  lastCompressionAt?: string | undefined;
}

export interface SessionMemoryState {
  enabled: boolean;
  sessionId: string;
  filePath: string;
  content: string;
  coveredMessageCount: number;
  updateCount: number;
  lastUpdatedAt?: string | undefined;
  lastError?: string | undefined;
}

export interface ContextManagementState {
  budget: ContextBudget;
  stats: CompactionStats;
  sessionMemory: SessionMemoryState;
  fullMessageCount: number;
  activeMessageCount: number;
}

export interface CompressedContextSnapshot {
  targetArchiveCount: number;
  archivedMessages: SessionMessage[];
  keptRecentMessages: SessionMessage[];
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
const RESERVED_SUMMARY_OUTPUT_TOKENS = 6_000;
const AUTO_COMPACT_BUFFER_TOKENS = 12_000;
const RECENT_TAIL_MIN_TOKENS = 12_000;
const RECENT_TAIL_MAX_TOKENS = 36_000;
const DEFAULT_SESSION_MEMORY_INIT_TOKENS = 4_000;
const DEFAULT_SESSION_MEMORY_UPDATE_TOKENS = 6_000;
const DEFAULT_SESSION_MEMORY_MAX_OUTPUT_TOKENS = 2_400;
const DEFAULT_COMPACTION_MAX_OUTPUT_TOKENS = 3_200;
const MIN_ATOMIC_GROUPS_TO_KEEP = 4;

const DEFAULT_CONTEXT_WINDOW_BY_PROVIDER: Record<ProviderKind, number> = {
  openai: 128_000,
  "openai-compatible": 128_000,
  anthropic: 200_000,
  bedrock: 200_000,
  gemini: 128_000,
};

const MODEL_CONTEXT_WINDOW_HINTS = [
  { pattern: /claude|anthropic/i, value: 200_000 },
  { pattern: /gpt-5|gpt-4\.1|gpt-4o|o1|o3|o4/i, value: 128_000 },
  { pattern: /gemini/i, value: 128_000 },
];

function nowIso(): string {
  return new Date().toISOString();
}

export function createCompactionStats(
  autoCompactEnabled = true,
): CompactionStats {
  return {
    autoCompactEnabled,
    compressionCount: 0,
    archivedMessageCount: 0,
  };
}

export function createSessionMemoryState(
  sessionId: string,
  enabled = true,
): SessionMemoryState {
  return {
    enabled,
    sessionId,
    filePath: getSessionMemoryPath(sessionId),
    content: "",
    coveredMessageCount: 0,
    updateCount: 0,
  };
}

export function ensureSessionMemoryFile(
  sessionMemory: SessionMemoryState,
): void {
  mkdirSync(dirname(sessionMemory.filePath), { recursive: true });
  const content = sessionMemory.content.trim()
    ? `${sessionMemory.content.trim()}\n`
    : "";
  writeFileSync(sessionMemory.filePath, content, "utf8");
}

export function cloneCompactionStats(
  stats: CompactionStats,
): CompactionStats {
  return {
    autoCompactEnabled: stats.autoCompactEnabled,
    compressionCount: stats.compressionCount,
    archivedMessageCount: stats.archivedMessageCount,
    ...(stats.lastCompressionReason
      ? { lastCompressionReason: stats.lastCompressionReason }
      : {}),
    ...(stats.lastCompressionAt
      ? { lastCompressionAt: stats.lastCompressionAt }
      : {}),
  };
}

export function cloneSessionMemoryState(
  sessionMemory: SessionMemoryState,
): SessionMemoryState {
  return {
    enabled: sessionMemory.enabled,
    sessionId: sessionMemory.sessionId,
    filePath: sessionMemory.filePath,
    content: sessionMemory.content,
    coveredMessageCount: sessionMemory.coveredMessageCount,
    updateCount: sessionMemory.updateCount,
    ...(sessionMemory.lastUpdatedAt
      ? { lastUpdatedAt: sessionMemory.lastUpdatedAt }
      : {}),
    ...(sessionMemory.lastError ? { lastError: sessionMemory.lastError } : {}),
  };
}

export function resolveContextBudget(
  profile: ResolvedProviderProfile,
  model: string,
): ContextBudget {
  const descriptor = getModelCatalog(profile).find((entry) => entry.id === model);
  const hintedWindow = MODEL_CONTEXT_WINDOW_HINTS.find((entry) =>
    entry.pattern.test(model),
  )?.value;
  const modelContextWindow =
    descriptor?.contextWindow ??
    hintedWindow ??
    DEFAULT_CONTEXT_WINDOW_BY_PROVIDER[profile.meta.kind] ??
    DEFAULT_CONTEXT_WINDOW;
  const effectiveContextWindow = Math.max(
    16_000,
    modelContextWindow - RESERVED_SUMMARY_OUTPUT_TOKENS,
  );
  const autoCompactThreshold = Math.max(
    8_000,
    effectiveContextWindow - AUTO_COMPACT_BUFFER_TOKENS,
  );
  const recentTailTokenBudget = Math.max(
    RECENT_TAIL_MIN_TOKENS,
    Math.min(
      RECENT_TAIL_MAX_TOKENS,
      Math.floor(effectiveContextWindow * 0.2),
    ),
  );

  return {
    modelContextWindow,
    reservedSummaryOutputTokens: RESERVED_SUMMARY_OUTPUT_TOKENS,
    effectiveContextWindow,
    autoCompactThreshold,
    recentTailTokenBudget,
    isModelContextWindowKnown: typeof descriptor?.contextWindow === "number",
  };
}

export function shouldAutoCompact(
  tokenEstimate: number,
  budget: ContextBudget,
): boolean {
  return tokenEstimate >= budget.autoCompactThreshold;
}

export function getSessionMemoryThreshold(
  hasContent: boolean,
): number {
  return hasContent
    ? DEFAULT_SESSION_MEMORY_UPDATE_TOKENS
    : DEFAULT_SESSION_MEMORY_INIT_TOKENS;
}

export function getSessionMemoryMaxOutputTokens(): number {
  return DEFAULT_SESSION_MEMORY_MAX_OUTPUT_TOKENS;
}

export function getCompactionMaxOutputTokens(): number {
  return DEFAULT_COMPACTION_MAX_OUTPUT_TOKENS;
}

export function estimateTextTokens(text: string): number {
  if (!text.trim()) {
    return 0;
  }
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 3));
}

export function estimateMessagesTokens(
  messages: SessionMessage[],
  systemPrompt?: string | undefined,
): number {
  return messages.reduce((total, message) => {
    return total + estimateMessageTokens(message);
  }, estimateTextTokens(systemPrompt ?? ""));
}

export function estimateMessageTokens(message: SessionMessage): number {
  const base = `[${message.role}] ${formatMessageForTranscript(message)}`;
  return estimateTextTokens(base) + 8;
}

function formatMessageForTranscript(message: SessionMessage): string {
  if (message.role === "tool") {
    const toolName = message.toolName ? `${message.toolName}: ` : "";
    return `${toolName}${getMessageText(message)}`.trim();
  }

  return getMessageText(message);
}

export function formatMessagesAsTranscript(messages: SessionMessage[]): string {
  return messages
    .map((message) => {
      const prefix =
        message.role === "tool" && message.toolName
          ? `[tool:${message.toolName}]`
          : `[${message.role}]`;
      return `${prefix} ${formatMessageForTranscript(message)}`.trim();
    })
    .join("\n\n");
}

export function buildCompressedSummaryMessage(summaryText: string): SessionMessage {
  return createUserMessage(
    `[MoeCli compressed context]\n${summaryText.trim()}\n\nRecent messages continue below verbatim. Resume without re-asking already resolved questions unless the preserved recent messages introduce a real conflict.`,
  );
}

export function buildSessionMemorySystemPrompt(): string {
  return [
    "You maintain durable coding-session memory for an interactive CLI.",
    "Respond in markdown only.",
    "Do not call tools.",
    "Merge the existing memory with the newly provided conversation delta.",
    "Keep the result concise but actionable.",
    "Preserve concrete decisions, important files, errors/fixes, active constraints, and the exact current task state.",
  ].join(" ");
}

export function buildSessionMemoryUserPrompt(
  currentMemory: string,
  deltaMessages: SessionMessage[],
): string {
  return [
    "Update the session memory for this coding conversation.",
    "",
    "Current memory",
    currentMemory.trim() ? currentMemory.trim() : "(empty)",
    "",
    "New conversation delta",
    formatMessagesAsTranscript(deltaMessages),
    "",
    "Return markdown with these sections:",
    "## User Goals",
    "## Decisions and Constraints",
    "## Important Files and Modules",
    "## Errors and Fixes",
    "## Current State",
    "## Next Steps",
  ].join("\n");
}

export function buildCompactionSummarySystemPrompt(): string {
  return [
    "You are compacting a long coding conversation so work can continue in a smaller context window.",
    "Respond in markdown only.",
    "Do not call tools.",
    "Produce a continuation summary that another instance can pick up immediately.",
    "Be concrete about user intent, current state, key files, tool results, decisions, and pending work.",
  ].join(" ");
}

export function buildCompactionSummaryUserPrompt(
  previousSummary: string | undefined,
  archivedMessages: SessionMessage[],
): string {
  return [
    "Compress the archived portion of this conversation into a continuation summary.",
    "",
    "Previous compressed summary",
    previousSummary?.trim() ? previousSummary.trim() : "(none)",
    "",
    "Newly archived conversation slice",
    formatMessagesAsTranscript(archivedMessages),
    "",
    "Return markdown with these sections:",
    "## User Goals",
    "## Decisions and Constraints",
    "## Important Files and Modules",
    "## Errors and Fixes",
    "## Current State",
    "## Pending Work",
  ].join("\n");
}

export function buildDeterministicFallbackSummary(
  previousSummary: string | undefined,
  archivedMessages: SessionMessage[],
): string {
  const importantUserMessages = archivedMessages
    .filter((message) => message.role === "user")
    .map((message) => formatMessageForTranscript(message))
    .filter(Boolean)
    .slice(-6);
  const recentFiles = archivedMessages
    .flatMap((message) => {
      const text = formatMessageForTranscript(message);
      return text.match(/[A-Za-z]:\\[^\s"'`]+|(?:src|agents|browser|config|providers|session|tools|utils)\/[^\s"'`]+/g) ?? [];
    })
    .slice(-10);

  return [
    "## User Goals",
    importantUserMessages.length > 0
      ? importantUserMessages.map((message) => `- ${message}`).join("\n")
      : "- Continue the existing coding conversation.",
    "",
    "## Decisions and Constraints",
    previousSummary?.trim() ? previousSummary.trim() : "- No earlier summary was available.",
    "",
    "## Important Files and Modules",
    recentFiles.length > 0
      ? [...new Set(recentFiles)].map((file) => `- ${file}`).join("\n")
      : "- Refer to the preserved recent messages for exact files.",
    "",
    "## Current State",
    "- Earlier context was deterministically compressed after the summarizer failed or was unavailable.",
    "- Continue from the preserved recent messages without redoing already completed work.",
  ].join("\n");
}

export function isLikelyContextOverflowError(error: unknown): boolean {
  const raw = error as { status?: number | undefined } | undefined;
  const status = raw?.status;
  const normalized = String(
    error instanceof Error ? error.message : error,
  ).toLowerCase();

  if (status === 413) {
    return true;
  }

  return [
    "context window",
    "context_length_exceeded",
    "context length",
    "maximum context",
    "prompt too long",
    "too many tokens",
    "input is too long",
    "exceeds the model's context",
    "model_context_window_exceeded",
    "token limit",
    "request is too large",
    "maximum input tokens",
  ].some((pattern) => normalized.includes(pattern));
}

export function isContextOverflowFinishReason(
  finishReason: string | undefined,
): boolean {
  const normalized = finishReason?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return [
    "model_context_window_exceeded",
    "context_window_exceeded",
    "max_input_tokens",
    "max_prompt_tokens",
  ].includes(normalized);
}

export function chooseMessagesToArchive(
  rawMessages: SessionMessage[],
  budget: ContextBudget,
  interactionMode: InteractionMode,
  taskState?: TaskModeState | undefined,
): CompressedContextSnapshot | undefined {
  const groups = groupAtomicMessagePairs(rawMessages);
  if (groups.length <= MIN_ATOMIC_GROUPS_TO_KEEP) {
    return undefined;
  }

  const keepFromGroupIndex = getMandatoryKeepGroupIndex(
    groups,
    interactionMode,
    taskState,
  );
  const preservedGroups = [] as SessionMessage[][];
  let recentTokens = 0;

  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index]!;
    preservedGroups.unshift(group);
    recentTokens += estimateMessagesTokens(group);
    const crossedBudget = recentTokens >= budget.recentTailTokenBudget;
    const keptEnoughGroups =
      preservedGroups.length >= MIN_ATOMIC_GROUPS_TO_KEEP && crossedBudget;
    const hasSatisfiedMandatoryBoundary =
      keepFromGroupIndex === undefined || index <= keepFromGroupIndex;

    if (keptEnoughGroups && hasSatisfiedMandatoryBoundary) {
      break;
    }
  }

  const archiveGroupCount = groups.length - preservedGroups.length;
  if (archiveGroupCount <= 0) {
    return undefined;
  }

  const archivedMessages = groups.slice(0, archiveGroupCount).flat();
  const keptRecentMessages = preservedGroups.flat();
  return {
    targetArchiveCount: archivedMessages.length,
    archivedMessages,
    keptRecentMessages,
  };
}

export function chunkMessagesByTokenBudget(
  messages: SessionMessage[],
  maxTokens: number,
): SessionMessage[][] {
  const groups = groupAtomicMessagePairs(messages);
  const chunks = [] as SessionMessage[][];
  let currentChunk = [] as SessionMessage[];
  let currentTokens = 0;

  for (const group of groups) {
    const groupTokens = estimateMessagesTokens(group);
    if (
      currentChunk.length > 0 &&
      currentTokens + groupTokens > maxTokens
    ) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentTokens = 0;
    }

    currentChunk.push(...group);
    currentTokens += groupTokens;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function groupAtomicMessagePairs(messages: SessionMessage[]): SessionMessage[][] {
  const groups = [] as SessionMessage[][];
  let index = 0;

  while (index < messages.length) {
    const message = messages[index]!;
    if (message.role === "assistant") {
      const toolCalls = message.parts
        .filter((part): part is Extract<typeof part, { type: "tool-call" }> => {
          return part.type === "tool-call";
        })
        .map((part) => part.call.id);

      if (toolCalls.length > 0) {
        const group = [message];
        const pending = new Set(toolCalls);
        let cursor = index + 1;

        while (cursor < messages.length) {
          const next = messages[cursor]!;
          if (
            next.role === "tool" &&
            next.toolCallId &&
            pending.has(next.toolCallId)
          ) {
            group.push(next);
            pending.delete(next.toolCallId);
            cursor += 1;
            continue;
          }
          break;
        }

        groups.push(group);
        index = cursor;
        continue;
      }
    }

    groups.push([message]);
    index += 1;
  }

  return groups;
}

function getMandatoryKeepGroupIndex(
  groups: SessionMessage[][],
  interactionMode: InteractionMode,
  taskState?: TaskModeState | undefined,
): number | undefined {
  if (
    interactionMode !== "task" ||
    !taskState ||
    taskState.phase === "executing"
  ) {
    return undefined;
  }

  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index]!;
    if (group.some((message) => message.role === "user")) {
      return index;
    }
  }

  return undefined;
}

export function markCompaction(
  stats: CompactionStats,
  archivedMessageCount: number,
  trigger: CompressionTrigger,
): CompactionStats {
  return {
    autoCompactEnabled: stats.autoCompactEnabled,
    compressionCount: stats.compressionCount + 1,
    archivedMessageCount: stats.archivedMessageCount + archivedMessageCount,
    lastCompressionReason: trigger,
    lastCompressionAt: nowIso(),
  };
}

export function markSessionMemoryUpdated(
  sessionMemory: SessionMemoryState,
  content: string,
  coveredMessageCount: number,
): SessionMemoryState {
  return {
    enabled: sessionMemory.enabled,
    sessionId: sessionMemory.sessionId,
    filePath: sessionMemory.filePath,
    content,
    coveredMessageCount,
    updateCount: sessionMemory.updateCount + 1,
    lastUpdatedAt: nowIso(),
  };
}

export function markSessionMemoryError(
  sessionMemory: SessionMemoryState,
  error: string,
): SessionMemoryState {
  return {
    enabled: sessionMemory.enabled,
    sessionId: sessionMemory.sessionId,
    filePath: sessionMemory.filePath,
    content: sessionMemory.content,
    coveredMessageCount: sessionMemory.coveredMessageCount,
    updateCount: sessionMemory.updateCount,
    ...(sessionMemory.lastUpdatedAt
      ? { lastUpdatedAt: sessionMemory.lastUpdatedAt }
      : {}),
    lastError: error,
  };
}
