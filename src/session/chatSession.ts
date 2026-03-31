import { randomUUID } from "node:crypto";
import type { JsonValue } from "../types/shared.js";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_MAX_TOOL_TURNS,
  DEFAULT_TASK_PLANNING_MAX_TOOL_TURNS,
} from "../utils/constants.js";
import { buildSystemPrompt, type InteractionMode } from "../cli/interactionMode.js";
import { getProviderAdapter } from "../providers/index.js";
import type {
  CompletionRequest,
  CompletionResult,
  ResolvedProviderProfile,
  SessionMessage,
  UnifiedStreamEvent,
  UnifiedToolDefinition,
} from "../providers/types.js";
import {
  collectText,
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  getResponseConversationState,
} from "../providers/helpers.js";
import {
  executeToolCall,
  getAvailableTools,
  type ToolExecutionContext,
} from "../tools/registry.js";
import {
  createTaskModeState,
  type TaskModeState,
} from "./taskTypes.js";
import {
  buildCompressedSummaryMessage,
  buildCompactionSummarySystemPrompt,
  buildCompactionSummaryUserPrompt,
  buildDeterministicFallbackSummary,
  buildSessionMemorySystemPrompt,
  buildSessionMemoryUserPrompt,
  chunkMessagesByTokenBudget,
  chooseMessagesToArchive,
  cloneCompactionStats,
  cloneSessionMemoryState,
  createCompactionStats,
  createSessionMemoryState,
  ensureSessionMemoryFile,
  estimateMessagesTokens,
  getCompactionMaxOutputTokens,
  getSessionMemoryMaxOutputTokens,
  getSessionMemoryThreshold,
  isContextOverflowFinishReason,
  isLikelyContextOverflowError,
  markCompaction,
  markSessionMemoryError,
  markSessionMemoryUpdated,
  resolveContextBudget,
  shouldAutoCompact,
  type CompactionStats,
  type CompressionTrigger,
  type ContextManagementState,
  type SessionMemoryState,
} from "./contextManagement.js";

const MAX_OVERFLOW_RETRIES_PER_TURN = 2;

interface ChatSessionOptions {
  profile: ResolvedProviderProfile;
  model: string;
  cwd: string;
  interactionMode?: InteractionMode | undefined;
  systemPromptBase?: string | undefined;
  systemPrompt?: string | undefined;
  tools?: UnifiedToolDefinition[] | undefined;
  toolContext: ToolExecutionContext;
  maxToolTurns?: number | undefined;
  maxPlanningToolTurns?: number | undefined;
  maxOutputTokens?: number | undefined;
  taskState?: TaskModeState | undefined;
  resetTaskPhaseOnUserTurn?: boolean | undefined;
}

interface ChatSessionSnapshot {
  providerState: JsonValue | undefined;
  messageCount: number;
  taskState?: TaskModeState | undefined;
  activeRawStartIndex: number;
  compressedSummaryText?: string | undefined;
  compactionStats: CompactionStats;
  sessionMemory: SessionMemoryState;
}

export class ChatSession {
  readonly profile: ResolvedProviderProfile;
  model: string;
  readonly cwd: string;
  interactionMode: InteractionMode;
  systemPromptBase?: string | undefined;
  readonly tools: UnifiedToolDefinition[];
  toolContext: ToolExecutionContext;
  readonly messages: SessionMessage[] = [];

  private providerState: JsonValue | undefined;
  private readonly maxToolTurns: number;
  private readonly maxPlanningToolTurns: number;
  private readonly maxOutputTokens: number;
  private readonly resetTaskPhaseOnUserTurn: boolean;
  private taskState?: TaskModeState | undefined;
  private activeRawStartIndex = 0;
  private compressedSummaryText?: string | undefined;
  private readonly sessionId = randomUUID();
  private compactionStats = createCompactionStats(true);
  private sessionMemory = createSessionMemoryState(this.sessionId, true);

  constructor(options: ChatSessionOptions) {
    this.profile = options.profile;
    this.model = options.model;
    this.cwd = options.cwd;
    this.interactionMode = options.interactionMode ?? "chat-edit";
    this.systemPromptBase = options.systemPromptBase ?? options.systemPrompt;
    this.tools = options.tools ?? [];
    this.toolContext = options.toolContext;
    this.maxToolTurns = options.maxToolTurns ?? DEFAULT_MAX_TOOL_TURNS;
    this.maxPlanningToolTurns =
      options.maxPlanningToolTurns ?? DEFAULT_TASK_PLANNING_MAX_TOOL_TURNS;
    this.maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.resetTaskPhaseOnUserTurn = options.resetTaskPhaseOnUserTurn ?? true;
    this.taskState =
      options.taskState ??
      (this.interactionMode === "task" ? createTaskModeState() : undefined);
    this.toolContext.interactionMode = this.interactionMode;
    this.toolContext.taskState = this.taskState;
    ensureSessionMemoryFile(this.sessionMemory);
  }

  updateSystemPrompt(
    systemPromptBase: string | undefined,
    resetProviderState = false,
  ): void {
    this.systemPromptBase = systemPromptBase;
    if (resetProviderState) {
      this.providerState = undefined;
    }
  }

  setInteractionMode(
    interactionMode: InteractionMode,
    resetProviderState = false,
  ): void {
    this.interactionMode = interactionMode;
    this.toolContext.interactionMode = interactionMode;
    this.taskState =
      interactionMode === "task" ? createTaskModeState("planning") : undefined;
    this.toolContext.taskState = this.taskState;
    if (resetProviderState) {
      this.providerState = undefined;
    }
  }

  getTaskState(): TaskModeState | undefined {
    return this.taskState;
  }

  getContextManagementState(): ContextManagementState {
    const budget = resolveContextBudget(this.profile, this.model);
    return {
      budget,
      stats: cloneCompactionStats(this.compactionStats),
      sessionMemory: cloneSessionMemoryState(this.sessionMemory),
      fullMessageCount: this.messages.length,
      activeMessageCount: this.getActiveMessages().length,
    };
  }

  async send(
    userInput: string,
    onEvent?: (event: UnifiedStreamEvent) => void | Promise<void>,
  ): Promise<CompletionResult> {
    const snapshot = this.snapshotState();

    this.prepareForUserTurn();
    const turnToolTurnLimit = this.getActiveToolTurnLimit();
    this.messages.push(createUserMessage(userInput));

    try {
      return await this.runLoop(turnToolTurnLimit, onEvent);
    } catch (error) {
      this.restoreSnapshot(snapshot);
      throw error;
    }
  }

  getTranscript(): string {
    return this.messages
      .map((message) => `[${message.role}] ${collectText(message.parts)}`)
      .join("\n\n");
  }

  private snapshotState(): ChatSessionSnapshot {
    return {
      providerState: this.providerState,
      messageCount: this.messages.length,
      taskState: this.cloneTaskState(),
      activeRawStartIndex: this.activeRawStartIndex,
      compressedSummaryText: this.compressedSummaryText,
      compactionStats: cloneCompactionStats(this.compactionStats),
      sessionMemory: cloneSessionMemoryState(this.sessionMemory),
    };
  }

  private restoreSnapshot(snapshot: ChatSessionSnapshot): void {
    this.providerState = snapshot.providerState;
    this.messages.splice(snapshot.messageCount);
    this.restoreTaskState(snapshot.taskState);
    this.activeRawStartIndex = snapshot.activeRawStartIndex;
    this.compressedSummaryText = snapshot.compressedSummaryText;
    this.compactionStats = snapshot.compactionStats;
    this.sessionMemory = snapshot.sessionMemory;
    ensureSessionMemoryFile(this.sessionMemory);
  }

  private getActiveSystemPrompt(): string | undefined {
    return buildSystemPrompt(
      this.interactionMode,
      this.systemPromptBase,
      this.taskState?.phase,
    );
  }

  private getActiveTools(): UnifiedToolDefinition[] {
    return getAvailableTools(this.tools, this.toolContext);
  }

  private getActiveToolTurnLimit(): number {
    if (
      this.interactionMode === "task" &&
      this.taskState?.phase !== "executing"
    ) {
      return this.maxPlanningToolTurns;
    }

    return this.maxToolTurns;
  }

  private getRawActiveMessages(): SessionMessage[] {
    return this.messages.slice(this.activeRawStartIndex);
  }

  private getActiveMessages(): SessionMessage[] {
    const tail = this.getRawActiveMessages();
    if (!this.compressedSummaryText?.trim()) {
      return tail;
    }

    return [buildCompressedSummaryMessage(this.compressedSummaryText), ...tail];
  }

  private prepareForUserTurn(): void {
    if (this.interactionMode !== "task") {
      return;
    }

    if (!this.taskState) {
      this.taskState = createTaskModeState("planning");
      this.toolContext.taskState = this.taskState;
      return;
    }

    this.taskState.pendingPlan = undefined;
    if (!this.resetTaskPhaseOnUserTurn) {
      this.toolContext.taskState = this.taskState;
      return;
    }

    this.taskState.phase = "planning";
  }

  private cloneTaskState(): TaskModeState | undefined {
    if (!this.taskState) {
      return undefined;
    }

    return {
      phase: this.taskState.phase,
      ...(this.taskState.pendingPlan
        ? {
            pendingPlan: {
              ...this.taskState.pendingPlan,
              tasks: [...this.taskState.pendingPlan.tasks],
              tests: [...this.taskState.pendingPlan.tests],
              risks: [...this.taskState.pendingPlan.risks],
              assumptions: [...this.taskState.pendingPlan.assumptions],
            },
          }
        : {}),
    };
  }

  private restoreTaskState(taskState: TaskModeState | undefined): void {
    this.taskState = taskState;
    this.toolContext.taskState = taskState;
  }

  private getSessionMemoryChunkBudget(): number {
    const effectiveWindow = resolveContextBudget(this.profile, this.model)
      .effectiveContextWindow;
    return Math.max(4_000, Math.min(12_000, Math.floor(effectiveWindow * 0.12)));
  }

  private getCompactionChunkBudget(): number {
    const effectiveWindow = resolveContextBudget(this.profile, this.model)
      .effectiveContextWindow;
    return Math.max(6_000, Math.min(18_000, Math.floor(effectiveWindow * 0.18)));
  }

  private async consumeProviderStream(
    request: CompletionRequest,
    onEvent?: (event: UnifiedStreamEvent) => void | Promise<void>,
  ): Promise<CompletionResult> {
    const adapter = getProviderAdapter(this.profile.meta.kind);
    const iterator = adapter.streamResponse(request)[Symbol.asyncIterator]();
    let result: CompletionResult | undefined;

    while (true) {
      const step = await iterator.next();
      if (step.done) {
        result = step.value;
        break;
      }

      if (onEvent) {
        await onEvent(step.value);
      }
    }

    if (!result) {
      throw new Error("Provider stream completed without a result.");
    }

    return result;
  }

  private async runInternalSummaryRequest(
    systemPrompt: string,
    userPrompt: string,
    maxOutputTokens: number,
  ): Promise<string> {
    const result = await this.consumeProviderStream({
      profile: this.profile,
      model: this.model,
      systemPrompt,
      messages: [createUserMessage(userPrompt)],
      tools: [],
      maxOutputTokens,
    });
    const text = collectText(result.assistantMessage.parts).trim();
    if (!text) {
      throw new Error("Internal summary request returned no text.");
    }
    return text;
  }

  private async maybeUpdateSessionMemory(
    targetMessageCount = this.messages.length,
    onEvent?: (event: UnifiedStreamEvent) => void | Promise<void>,
    force = false,
  ): Promise<boolean> {
    if (!this.sessionMemory.enabled) {
      return false;
    }

    const cappedTarget = Math.min(targetMessageCount, this.messages.length);
    if (cappedTarget <= this.sessionMemory.coveredMessageCount) {
      return false;
    }

    const deltaMessages = this.messages.slice(
      this.sessionMemory.coveredMessageCount,
      cappedTarget,
    );
    const deltaTokens = estimateMessagesTokens(deltaMessages);
    const threshold = getSessionMemoryThreshold(
      Boolean(this.sessionMemory.content.trim()),
    );
    if (!force && deltaTokens < threshold) {
      return false;
    }

    const chunks = chunkMessagesByTokenBudget(
      deltaMessages,
      Math.max(threshold, this.getSessionMemoryChunkBudget()),
    );
    if (chunks.length === 0) {
      return false;
    }

    try {
      let nextMemory = this.sessionMemory.content;
      let coveredMessageCount = this.sessionMemory.coveredMessageCount;

      for (const chunk of chunks) {
        nextMemory = await this.runInternalSummaryRequest(
          buildSessionMemorySystemPrompt(),
          buildSessionMemoryUserPrompt(nextMemory, chunk),
          getSessionMemoryMaxOutputTokens(),
        );
        coveredMessageCount += chunk.length;
      }

      this.sessionMemory = markSessionMemoryUpdated(
        this.sessionMemory,
        nextMemory,
        coveredMessageCount,
      );
      ensureSessionMemoryFile(this.sessionMemory);
      if (onEvent) {
        await onEvent({
          type: "status",
          message: "session memory updated",
          tone: "info",
        });
      }
      return true;
    } catch (error) {
      this.sessionMemory = markSessionMemoryError(
        this.sessionMemory,
        error instanceof Error ? error.message : String(error),
      );
      ensureSessionMemoryFile(this.sessionMemory);
      return false;
    }
  }

  private async buildCompactionSummary(
    archivedMessages: SessionMessage[],
  ): Promise<string> {
    const chunks = chunkMessagesByTokenBudget(
      archivedMessages,
      this.getCompactionChunkBudget(),
    );
    let summary = this.compressedSummaryText?.trim() || undefined;

    try {
      for (const chunk of chunks) {
        summary = await this.runInternalSummaryRequest(
          buildCompactionSummarySystemPrompt(),
          buildCompactionSummaryUserPrompt(summary, chunk),
          getCompactionMaxOutputTokens(),
        );
      }
    } catch {
      return buildDeterministicFallbackSummary(
        this.compressedSummaryText,
        archivedMessages,
      );
    }

    return summary?.trim()
      ? summary.trim()
      : buildDeterministicFallbackSummary(
          this.compressedSummaryText,
          archivedMessages,
        );
  }

  private resetProviderStateAfterCompaction(): void {
    const responseState = getResponseConversationState(this.providerState);
    const nextState = {
      ...(typeof responseState.supportsPreviousResponseId === "boolean"
        ? {
            supportsPreviousResponseId: responseState.supportsPreviousResponseId,
          }
        : {}),
      ...(typeof responseState.supportsReasoning === "boolean"
        ? { supportsReasoning: responseState.supportsReasoning }
        : {}),
      ...(typeof responseState.supportsTools === "boolean"
        ? { supportsTools: responseState.supportsTools }
        : {}),
    };

    this.providerState =
      Object.keys(nextState).length > 0
        ? (nextState as unknown as JsonValue)
        : undefined;
  }

  private async compactActiveContext(
    trigger: CompressionTrigger,
    onEvent?: (event: UnifiedStreamEvent) => void | Promise<void>,
  ): Promise<boolean> {
    const budget = resolveContextBudget(this.profile, this.model);
    const snapshot = chooseMessagesToArchive(
      this.getRawActiveMessages(),
      budget,
      this.interactionMode,
      this.taskState,
    );

    if (!snapshot) {
      return false;
    }

    const targetArchiveCount =
      this.activeRawStartIndex + snapshot.targetArchiveCount;
    await this.maybeUpdateSessionMemory(targetArchiveCount, onEvent, true);

    const nextSummary =
      this.sessionMemory.content.trim() &&
      this.sessionMemory.coveredMessageCount >= targetArchiveCount
        ? this.sessionMemory.content.trim()
        : await this.buildCompactionSummary(snapshot.archivedMessages);

    this.compressedSummaryText = nextSummary.trim();
    this.activeRawStartIndex = targetArchiveCount;
    this.compactionStats = markCompaction(
      this.compactionStats,
      snapshot.archivedMessages.length,
      trigger,
    );
    this.resetProviderStateAfterCompaction();

    if (onEvent) {
      await onEvent({
        type: "status",
        message:
          trigger === "overflow-retry"
            ? "context compressed after overflow; retrying"
            : "context compressed",
        tone: "warning",
      });
    }

    return true;
  }

  private async maybeAutoCompact(
    onEvent?: (event: UnifiedStreamEvent) => void | Promise<void>,
  ): Promise<boolean> {
    let compacted = false;

    while (this.compactionStats.autoCompactEnabled) {
      const budget = resolveContextBudget(this.profile, this.model);
      const tokenEstimate = estimateMessagesTokens(
        this.getActiveMessages(),
        this.getActiveSystemPrompt(),
      );
      if (!shouldAutoCompact(tokenEstimate, budget)) {
        break;
      }

      const didCompact = await this.compactActiveContext("proactive", onEvent);
      if (!didCompact) {
        break;
      }
      compacted = true;
    }

    return compacted;
  }

  private async tryRecoverFromOverflow(
    error: unknown,
    retryCount: number,
    onEvent?: (event: UnifiedStreamEvent) => void | Promise<void>,
    assumeOverflow = false,
  ): Promise<boolean> {
    if (retryCount >= MAX_OVERFLOW_RETRIES_PER_TURN) {
      return false;
    }

    if (!assumeOverflow && !isLikelyContextOverflowError(error)) {
      return false;
    }

    return this.compactActiveContext("overflow-retry", onEvent);
  }

  private async runLoop(
    turnToolTurnLimit: number,
    onEvent?: (event: UnifiedStreamEvent) => void | Promise<void>,
  ): Promise<CompletionResult> {
    let toolTurns = 0;
    let overflowRetries = 0;

    while (true) {
      await this.maybeUpdateSessionMemory(this.messages.length, onEvent);
      await this.maybeAutoCompact(onEvent);

      let result: CompletionResult;
      try {
        result = await this.consumeProviderStream(
          {
            profile: this.profile,
            model: this.model,
            systemPrompt: this.getActiveSystemPrompt(),
            messages: this.getActiveMessages(),
            tools: this.getActiveTools(),
            maxOutputTokens: this.maxOutputTokens,
            providerState: this.providerState,
          },
          onEvent,
        );
      } catch (error) {
        const recovered = await this.tryRecoverFromOverflow(
          error,
          overflowRetries,
          onEvent,
        );
        if (recovered) {
          overflowRetries += 1;
          continue;
        }
        throw error;
      }

      if (isContextOverflowFinishReason(result.finishReason)) {
        const recovered = await this.tryRecoverFromOverflow(
          new Error(`Provider reported ${result.finishReason}.`),
          overflowRetries,
          onEvent,
          true,
        );
        if (recovered) {
          overflowRetries += 1;
          continue;
        }
      }

      overflowRetries = 0;
      this.providerState = result.providerState ?? this.providerState;
      this.messages.push(result.assistantMessage);

      if (!result.toolCalls.length) {
        await this.maybeUpdateSessionMemory(this.messages.length, onEvent);
        return result;
      }

      toolTurns += 1;
      if (toolTurns > turnToolTurnLimit) {
        throw new Error(this.createToolLoopLimitError(turnToolTurnLimit));
      }

      let restartLoop = false;
      for (const toolCall of result.toolCalls) {
        if (onEvent) {
          await onEvent({
            type: "tool-execution-start",
            call: toolCall,
          });
        }

        const toolResult = await executeToolCall(toolCall, this.toolContext);
        if (onEvent) {
          await onEvent({
            type: "tool-result",
            call: toolCall,
            output: toolResult.output,
            ...(toolResult.isError ? { isError: true } : {}),
          });
        }

        this.messages.push(
          createToolResultMessage(
            toolCall,
            toolResult.output,
            Boolean(toolResult.isError),
          ),
        );

        if (toolResult.control?.endTurnText) {
          const assistantMessage = createAssistantMessage(
            toolResult.control.endTurnText,
            "",
            [],
          );
          this.messages.push(assistantMessage);
          await this.maybeUpdateSessionMemory(this.messages.length, onEvent);
          return {
            assistantMessage,
            toolCalls: [],
            finishReason: "cancelled",
          };
        }

        if (toolResult.control?.resetToolTurns) {
          toolTurns = 0;
        }

        if (toolResult.control?.restartLoop) {
          restartLoop = true;
          break;
        }
      }

      if (restartLoop) {
        continue;
      }
    }
  }

  private createToolLoopLimitError(limit: number): string {
    if (this.interactionMode !== "task") {
      return `Tool loop exceeded the limit of ${limit} turns.`;
    }

    if (this.taskState?.phase === "executing") {
      return `Tool loop exceeded the limit of ${limit} turns after plan approval.`;
    }

    return `Tool loop exceeded the limit of ${limit} turns during task planning.`;
  }
}
