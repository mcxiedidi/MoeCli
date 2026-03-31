import { Command } from "commander";
import {
  createInterface,
  type Interface as ReadlineInterface,
} from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { cwd as processCwd } from "node:process";
import { APP_NAME } from "../utils/constants.js";
import {
  formatDim,
  formatLabel,
  formatWarning,
} from "../utils/format.js";
import {
  createProfileId,
  deleteProfile,
  getManualModels,
  getModelCatalog,
  getProfileTransportMode,
  getSettings,
  resolveActiveProfile,
  resolveModelForProfile,
  setActiveProfile,
  setCachedModels,
  setDefaultModel,
  setManualModels,
  setTransportMode,
  updateSettings,
  upsertProfile,
} from "../config/settings.js";
import { deleteProfileSecrets, setProfileSecrets } from "../config/secrets.js";
import type {
  ModelDescriptor,
  ProviderKind,
  ProviderProfileMeta,
  ResolvedProviderProfile,
  UnifiedStreamEvent,
} from "../providers/types.js";
import { getProviderAdapter, listProviderAdapters } from "../providers/index.js";
import { getBuiltInTools, saveSearchApiKey } from "../tools/registry.js";
import { getBrowserSession } from "../browser/session.js";
import { AgentManager } from "../agents/manager.js";
import { ChatSession } from "../session/chatSession.js";
import { collectText } from "../providers/helpers.js";
import type {
  PendingTaskPlan,
  TaskPhase,
  TaskPlanDecision,
  UserInputQuestion,
  UserInputRequest,
  UserInputResult,
} from "../session/taskTypes.js";
import { getErrorMessage } from "../utils/errors.js";
import {
  buildModelCompletions,
  buildModeCompletions,
  buildSlashCommandCompletions,
  findSlashCommandSuggestions,
  SLASH_COMMANDS,
} from "./completion.js";
import {
  renderCommandRows,
  renderKeyValueRows,
  renderPanel,
} from "../utils/terminalUi.js";
import { theme } from "../utils/theme.js";
import { TurnRenderer } from "../utils/turnRenderer.js";
import {
  DEFAULT_INTERACTION_MODE,
  getInteractionModeDefinition,
  getNextInteractionMode,
  listInteractionModes,
  parseInteractionMode,
  type InteractionMode,
} from "./interactionMode.js";
import { createReplInputRouter, refreshActivePrompt } from "./replInput.js";
import {
  findSelectedOption,
  type SelectOption,
} from "./selectOptions.js";

interface RootOptions {
  profile?: string;
  model?: string;
  system?: string;
  mode?: string;
}

interface RuntimeContext {
  cwd: string;
  profile: ResolvedProviderProfile;
  model: string;
  interactionMode: InteractionMode;
  systemPromptBase?: string | undefined;
  browser: ReturnType<typeof getBrowserSession>;
  agents: AgentManager;
  session: ChatSession;
}

function getUiWidth(): number {
  const columns = stdout.columns ?? 92;
  return Math.max(48, Math.min(88, columns - 6));
}

function getTransportLabel(profile: ResolvedProviderProfile): string | undefined {
  if (profile.meta.kind !== "openai-compatible") {
    return undefined;
  }

  return getProfileTransportMode(profile.meta.id);
}

function buildPromptLabel(context: RuntimeContext): string {
  const transport = getTransportLabel(context.profile);
  const transportSuffix =
    transport && transport !== "auto" ? theme.dim(` [${transport}]`) : "";
  return `${theme.provider(
    context.profile.meta.kind,
    context.profile.meta.name,
  )}${theme.dim(" / ")}${theme.primarySoft(context.model)}${transportSuffix}`;
}

function buildPromptText(context: RuntimeContext): string {
  return `${buildPromptLabel(context)} ${theme.dim("/")} ${getModeTag(context)} ${theme.primaryBold(">")} `;
}

function printPanel(
  title: string,
  lines: string[],
  tone: "primary" | "success" | "warning" | "danger" | "info" = "primary",
): void {
  stdout.write(
    `${renderPanel(title, lines, {
      tone,
      maxWidth: getUiWidth(),
    })}\n`,
  );
}

function getTaskPhase(context: RuntimeContext): TaskPhase | undefined {
  return context.session.getTaskState()?.phase;
}

function formatTaskPhase(phase: TaskPhase): string {
  switch (phase) {
    case "awaiting-input":
      return "input";
    case "awaiting-approval":
      return "approval";
    default:
      return phase;
  }
}

function getModeTag(context: RuntimeContext): string {
  const definition = getInteractionModeDefinition(context.interactionMode);
  if (context.interactionMode !== "task") {
    return theme.info(`[${definition.promptTag}]`);
  }

  const phase = formatTaskPhase(getTaskPhase(context) ?? "planning");
  return theme.warning(`[${definition.promptTag}:${phase}]`);
}

function buildChatSession(
  profile: ResolvedProviderProfile,
  model: string,
  cwd: string,
  interactionMode: InteractionMode,
  systemPromptBase: string | undefined,
  browser = getBrowserSession(),
  agents = new AgentManager(),
  taskPhase?: TaskPhase,
  resetTaskPhaseOnUserTurn = true,
): ChatSession {
  return new ChatSession({
    profile,
    model,
    cwd,
    interactionMode,
    systemPromptBase,
    tools: getBuiltInTools(),
    toolContext: {
      cwd,
      profile,
      model,
      interactionMode,
      browser,
      agents,
    },
    ...(interactionMode === "task" && taskPhase
      ? {
          taskState: {
            phase: taskPhase,
          },
        }
      : {}),
    resetTaskPhaseOnUserTurn,
  });
}

function printSessionSummary(
  context: RuntimeContext,
  includeCommands = false,
): void {
  const adapter = getProviderAdapter(context.profile.meta.kind);
  const transport = getTransportLabel(context.profile);
  const mode = getInteractionModeDefinition(context.interactionMode);
  const taskPhase = getTaskPhase(context);
  const divider = theme.primary("-".repeat(Math.min(getUiWidth(), 72)));
  const sessionLine = [
    theme.provider(context.profile.meta.kind, context.profile.meta.name),
    theme.dim("/"),
    theme.primarySoft(context.model),
    theme.dim("/"),
    context.interactionMode === "task"
      ? theme.warning(
          taskPhase ? `${mode.label} (${formatTaskPhase(taskPhase)})` : mode.label,
        )
      : theme.info(mode.label),
    theme.dim("/"),
    theme.info(adapter.displayName),
    transport && transport !== "auto" ? theme.dim(`/ ${transport}`) : "",
  ]
    .filter(Boolean)
    .join(" ");

  stdout.write(
    `${theme.primaryBold(APP_NAME)} ${theme.dim(
      "provider-agnostic coding CLI",
    )}\n`,
  );
  stdout.write(`${sessionLine}\n`);
  stdout.write(`${theme.dim(context.cwd)}\n`);
  if (includeCommands) {
    stdout.write(
      `${theme.dim(
        "Tab complete | Shift+Tab mode switch | /mode | /providers | /model <id>",
      )}\n`,
    );
    if (context.interactionMode === "task") {
      stdout.write(
        `${theme.dim(
          "Task mode plans first, can ask follow-up questions, and waits for approval before execution.",
        )}\n`,
      );
    }
  }
  stdout.write(`${divider}\n`);
}

function printHelpPanel(): void {
  printPanel(
    "Command Cheat Sheet",
    [
      "Core",
      ...renderCommandRows(
        SLASH_COMMANDS.filter((command) =>
          ["/", "/help", "/status", "/clear", "/exit"].includes(command.command),
        ),
      ),
      "",
      "Setup",
      ...renderCommandRows(
        SLASH_COMMANDS.filter((command) =>
          ["/providers", "/model", "/mode", "/config", "/browser"].includes(
            command.command,
          ),
        ),
      ),
      "",
      "Tips",
      "Use /providers if a request keeps failing or you need to swap endpoints.",
      "OpenAI Compatible profiles may use auto, responses, or chat transport.",
      "Press Tab to complete slash commands and model ids after /model.",
      "Press Shift+Tab to cycle between Chat & Edit mode and Task mode.",
      "Task mode explores first, can ask you questions, then submits a plan for approval before execution.",
      "Browser, search, shell, files, and sub-agents are local features, not cloud-gated.",
    ],
    "info",
  );
}

function printStatusPanel(context: RuntimeContext): void {
  const settings = getSettings();
  const adapter = getProviderAdapter(context.profile.meta.kind);
  const transport = getTransportLabel(context.profile);
  const mode = getInteractionModeDefinition(context.interactionMode);
  const taskState = context.session.getTaskState();
  const contextState = context.session.getContextManagementState();
  const sessionMemoryStatus = contextState.sessionMemory.enabled
    ? `${contextState.sessionMemory.updateCount} updates / ${contextState.sessionMemory.coveredMessageCount} msgs`
    : "disabled";
  const autoCompactStatus = contextState.stats.autoCompactEnabled
    ? `enabled (${contextState.stats.compressionCount} compactions)`
    : "disabled";

  printPanel(
    "Session Status",
    [
      ...renderKeyValueRows([
        { label: "Profile", value: context.profile.meta.name },
        {
          label: "Provider",
          value: `${adapter.displayName} (${context.profile.meta.kind})`,
        },
        { label: "Model", value: context.model },
        { label: "Mode", value: mode.label },
        {
          label: "Task phase",
          value: taskState ? formatTaskPhase(taskState.phase) : undefined,
        },
        {
          label: "Pending plan",
          value: taskState ? (taskState.pendingPlan ? "yes" : "no") : undefined,
        },
        { label: "Auto-compact", value: autoCompactStatus },
        {
          label: "Messages",
          value: `${contextState.activeMessageCount} active / ${contextState.fullMessageCount} full`,
        },
        { label: "Session memory", value: sessionMemoryStatus },
        {
          label: "Memory file",
          value: contextState.sessionMemory.filePath,
        },
        { label: "Transport", value: transport },
        { label: "Base URL", value: context.profile.meta.baseUrl },
        {
          label: "Browser",
          value: settings.browser.enabled ? "enabled" : "disabled",
        },
        {
          label: "Search",
          value: settings.search.enabled ? settings.search.endpoint : "disabled",
        },
        { label: "Agent mode", value: settings.agents.defaultMode },
        { label: "Profiles", value: settings.providerProfiles.length },
        { label: "Directory", value: context.cwd },
      ]),
      "",
      mode.detail,
    ],
    "info",
  );
}

function printRuntimeErrorPanel(error: unknown, context: RuntimeContext): void {
  const message = getErrorMessage(error);
  const detail = message.split(/\r?\n/).find((line) => line.trim()) ?? message;
  const adapter = getProviderAdapter(context.profile.meta.kind);
  const transport = getTransportLabel(context.profile);
  const normalized = message.toLowerCase();
  const hints: string[] = [];

  if (context.profile.meta.kind === "openai-compatible") {
    if (
      normalized.includes("403") ||
      normalized.includes("blocked") ||
      normalized.includes("forbidden") ||
      normalized.includes("permission denied")
    ) {
      hints.push(
        "Verify the base URL points to a real OpenAI-compatible API endpoint, not a dashboard or website.",
        "Recheck the API key, required custom headers, and whether this service only supports chat completions.",
        "Use /providers to edit the profile if you want to pin the transport to chat.",
      );
    }
  }

  if (
    context.profile.meta.kind === "gemini" &&
    (normalized.includes("html") ||
      normalized.includes("<!doctype") ||
      normalized.includes("unexpected token '<'") ||
      normalized.includes("no stream events"))
  ) {
    hints.push(
      "The configured base URL looks like a website response, not the Gemini API.",
      "Use the official Gemini API base URL or your provider's actual Gemini-compatible API base.",
      "Retry after confirming the model id and API key.",
    );
  }

  if (hints.length === 0) {
    hints.push(
      "Use /status to confirm the active profile, provider, model, and transport.",
      "Use /providers to edit the profile or switch to another one.",
    );
  }

  if (
    normalized.includes("prompt too long") ||
    normalized.includes("context window") ||
    normalized.includes("context_length_exceeded") ||
    normalized.includes("maximum input tokens")
  ) {
    hints.unshift(
      "MoeCli already tried to compact the active context automatically before surfacing this error.",
      "This usually means the remaining live tail or the latest prompt is still too large to fit in the selected model window.",
    );
  }

  if (
    context.interactionMode === "task" &&
    normalized.includes("tool loop exceeded")
  ) {
    if (normalized.includes("after plan approval")) {
      hints.unshift(
        "This task already moved into execution after plan approval and still hit the tool budget for the same turn.",
        "Try approving a narrower plan, or continue from a more specific follow-up prompt so execution needs fewer tool hops.",
      );
    } else {
      hints.unshift(
        "This happened before execution finished planning. Narrow the request, answer any follow-up question, or revise the proposed plan so it converges faster.",
      );
    }
  }

  printPanel(
    "Request Failed",
    [
      ...renderKeyValueRows([
        { label: "Profile", value: context.profile.meta.name },
        {
          label: "Provider",
          value: `${adapter.displayName} (${context.profile.meta.kind})`,
        },
        { label: "Model", value: context.model },
        { label: "Transport", value: transport },
      ]),
      "",
      `Detail: ${detail}`,
      "",
      "Next steps",
      ...hints.map((hint) => `- ${hint}`),
    ],
    "danger",
  );
}

function printNoOutputPanel(context: RuntimeContext): void {
  const hints =
    context.profile.meta.kind === "gemini"
      ? [
          "This often means the endpoint did not return Gemini-style stream events.",
          "Double-check the base URL. A website URL can look healthy at first but still return no model output.",
          "Use /providers to edit the profile or switch back to the official Gemini API base.",
        ]
      : [
          "The provider finished the turn without visible text or tool calls.",
          "Check the selected model and provider settings with /status.",
          "If this keeps happening, edit the current profile in /providers.",
        ];

  printPanel(
    "No Visible Output",
    [
      ...renderKeyValueRows([
        { label: "Profile", value: context.profile.meta.name },
        { label: "Provider", value: context.profile.meta.kind },
        { label: "Model", value: context.model },
      ]),
      "",
      ...hints.map((hint) => `- ${hint}`),
    ],
    "warning",
  );
}

async function promptText(
  message: string,
  initial = "",
  rl?: ReadlineInterface,
): Promise<string | undefined> {
  const suffix = initial ? ` ${formatDim(`[default: ${initial}]`)}` : "";
  return withPromptReader(rl, async (reader) => {
    const answer = (await reader.question(
      `${formatLabel(message)}${suffix}: `,
    )).trim();
    return answer || initial || undefined;
  });
}

async function promptConfirm(
  message: string,
  initial = false,
  rl?: ReadlineInterface,
): Promise<boolean> {
  return withPromptReader(rl, async (reader) => {
    const hint = initial ? "[Y/n]" : "[y/N]";
    while (true) {
      const answer = (await reader.question(
        `${formatLabel(message)} ${formatDim(hint)}: `,
      ))
        .trim()
        .toLowerCase();
      if (!answer) {
        return initial;
      }
      if (["y", "yes"].includes(answer)) {
        return true;
      }
      if (["n", "no"].includes(answer)) {
        return false;
      }
      stdout.write(`${formatWarning("Please enter y or n.")}\n`);
    }
  });
}

function ensureInteractiveTerminal(): void {
  if (!stdin.isTTY) {
    throw new Error(
      "This interaction requires an interactive terminal session.",
    );
  }
}

async function promptUserInputRequestInteractive(
  request: UserInputRequest,
  rl?: ReadlineInterface,
): Promise<UserInputResult> {
  ensureInteractiveTerminal();
  const answers = [] as UserInputResult["answers"];

  for (let index = 0; index < request.questions.length; index += 1) {
    const question = request.questions[index]!;
    const answer = await promptSingleUserQuestion(
      question,
      index + 1,
      request.questions.length,
      rl,
    );
    if (answer === "cancelled") {
      return {
        status: "cancelled",
        answers,
        answersById: {},
      };
    }
    answers.push(answer);
  }

  return {
    status: "answered",
    answers,
    answersById: {},
  };
}

async function promptSingleUserQuestion(
  question: UserInputQuestion,
  position: number,
  total: number,
  rl?: ReadlineInterface,
): Promise<UserInputResult["answers"][number] | "cancelled"> {
  return withPromptReader(rl, async (reader) => {
    printPanel(
      `${question.header} (${position}/${total})`,
      [
        question.question,
        "",
        "Options",
        ...question.options.map(
          (option, index) =>
            `${String(index + 1).padStart(2, " ")}. ${option.label} - ${option.description}${index === 0 ? " [recommended]" : ""}`,
        ),
        "",
        'Press Enter for the first option, type a number, type a custom answer, or type "cancel".',
      ],
      "primary",
    );

    while (true) {
      const raw = (await reader.question(
        `${formatLabel(question.header)} ${formatDim("[choice/custom/cancel]")}: `,
      )).trim();

      if (!raw) {
        const selected = question.options[0]!;
        return {
          id: question.id,
          question: question.question,
          selectedOption: selected,
        };
      }

      if (raw.toLowerCase() === "cancel") {
        return "cancelled";
      }

      const numeric = Number(raw);
      if (
        Number.isInteger(numeric) &&
        numeric >= 1 &&
        numeric <= question.options.length
      ) {
        const selected = question.options[numeric - 1]!;
        return {
          id: question.id,
          question: question.question,
          selectedOption: selected,
        };
      }

      const matched = question.options.find(
        (option) => option.label.toLowerCase() === raw.toLowerCase(),
      );
      if (matched) {
        return {
          id: question.id,
          question: question.question,
          selectedOption: matched,
        };
      }

      return {
        id: question.id,
        question: question.question,
        freeformText: raw,
      };
    }
  });
}

async function promptTaskPlanApprovalInteractive(
  plan: PendingTaskPlan,
  rl?: ReadlineInterface,
): Promise<TaskPlanDecision> {
  ensureInteractiveTerminal();
  printPanel(
    "Task Plan",
    [
      ...renderKeyValueRows([{ label: "Title", value: plan.title }]),
      "",
      plan.summary,
      "",
      "Tasks",
      ...plan.tasks.map((task, index) => `${index + 1}. ${task}`),
      ...(plan.tests.length > 0
        ? ["", "Tests", ...plan.tests.map((test) => `- ${test}`)]
        : []),
      ...(plan.risks.length > 0
        ? ["", "Risks", ...plan.risks.map((risk) => `- ${risk}`)]
        : []),
      ...(plan.assumptions.length > 0
        ? [
            "",
            "Assumptions",
            ...plan.assumptions.map((assumption) => `- ${assumption}`),
          ]
        : []),
    ],
    "primary",
  );

  const decision = await chooseOption(
    "Plan action",
    [
      {
        label: "Approve and execute",
        value: "approved" as const,
        aliases: ["approve", "approved", "execute"],
      },
      {
        label: "Revise plan",
        value: "revise" as const,
        aliases: ["revise", "revision"],
      },
      {
        label: "Cancel task",
        value: "cancelled" as const,
        aliases: ["cancel", "cancelled"],
      },
    ],
    undefined,
    rl,
    {
      allowBlank: false,
      promptHint: "[number or action]",
    },
  );

  if (decision === "revise") {
    const feedback =
      (await promptText("What should change in the plan?", "", rl))?.trim() ||
      "Please revise the plan before execution.";
    return {
      status: "revise",
      feedback,
    };
  }

  if (decision === "cancelled") {
    return { status: "cancelled" };
  }

  return { status: "approved" };
}

async function chooseProviderKind(
  initial?: ProviderKind,
  rl?: ReadlineInterface,
): Promise<ProviderKind | undefined> {
  return chooseOption(
    "Choose a provider type",
    listProviderAdapters().map((adapter) => ({
      label: `${adapter.displayName} (${adapter.kind})`,
      value: adapter.kind,
    })),
    initial,
    rl,
  );
}

async function parseHeadersInput(
  initial?: Record<string, string>,
  rl?: ReadlineInterface,
): Promise<Record<string, string> | undefined> {
  const text = await promptText(
    "Extra headers JSON (optional)",
    initial ? JSON.stringify(initial) : "",
    rl,
  );
  if (!text) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(text) as Record<string, string>;
    return parsed;
  } catch {
    stdout.write(`${formatWarning("Ignoring invalid header JSON.")}\n`);
    return undefined;
  }
}

async function refreshModelsForProfile(
  profile: ResolvedProviderProfile,
): Promise<ModelDescriptor[]> {
  const adapter = getProviderAdapter(profile.meta.kind);
  const models = await adapter.listModels(profile);
  if (models.length > 0) {
    setCachedModels(profile.meta.id, models);
  }
  return models;
}

async function chooseModelInteractive(
  profile: ResolvedProviderProfile,
  requestedModel?: string,
  rl?: ReadlineInterface,
): Promise<string> {
  const current = resolveModelForProfile(profile, requestedModel);
  const catalog = getModelCatalog(profile);

  if (!catalog.length) {
    const manual = await promptText("Enter a model id", current ?? "", rl);
    if (!manual) {
      throw new Error("A model is required.");
    }
    setManualModels(profile.meta.id, [
      {
        id: manual,
        label: manual,
        provider: profile.meta.kind,
        source: "manual",
      },
    ]);
    setDefaultModel(profile.meta.id, manual);
    return manual;
  }

  const response = await chooseOption(
    "Choose a model",
    [
      ...catalog.map((model) => ({
        label: `${model.label} [${model.source}]`,
        value: model.id,
      })),
      {
        label: "Manual input",
        value: "__manual__",
      },
    ],
    current,
    rl,
  );

  if (response === "__manual__") {
    const manual = await promptText("Enter a model id", current ?? "", rl);
    if (!manual) {
      throw new Error("A model is required.");
    }
    setManualModels(profile.meta.id, [
      {
        id: manual,
        label: manual,
        provider: profile.meta.kind,
        source: "manual",
      },
    ]);
    setDefaultModel(profile.meta.id, manual);
    return manual;
  }

  const model = response ?? current;
  if (!model) {
    throw new Error("A model is required.");
  }
  setDefaultModel(profile.meta.id, model);
  return model;
}

function rememberManualModel(
  profile: ResolvedProviderProfile,
  modelId: string,
): void {
  const catalog = getModelCatalog(profile);
  if (catalog.some((entry) => entry.id === modelId)) {
    return;
  }

  setManualModels(profile.meta.id, [
    ...getManualModels(profile.meta.id)
      .map((entry) => ({
        id: entry.id,
        label: entry.label,
        provider: entry.provider,
        source: "manual" as const,
      })),
    {
      id: modelId,
      label: modelId,
      provider: profile.meta.kind,
      source: "manual",
    },
  ]);
}

function setModelDirectly(
  profile: ResolvedProviderProfile,
  modelId: string,
): string {
  const normalized = modelId.trim();
  if (!normalized) {
    throw new Error("A model id is required.");
  }

  rememberManualModel(profile, normalized);
  setDefaultModel(profile.meta.id, normalized);
  return normalized;
}

function applyInteractionMode(
  context: RuntimeContext,
  interactionMode: InteractionMode,
): RuntimeContext {
  if (context.interactionMode === interactionMode) {
    return context;
  }

  context.session.setInteractionMode(interactionMode, true);

  return {
    ...context,
    interactionMode,
  };
}

async function chooseInteractionMode(
  initial: InteractionMode,
  rl?: ReadlineInterface,
): Promise<InteractionMode | undefined> {
  return chooseOption(
    "Choose a mode",
    listInteractionModes().map((mode) => ({
      label: `${mode.label} (${mode.promptTag})`,
      value: mode.value,
    })),
    initial,
    rl,
  );
}

function buildReplCompleter(
  getContext: () => RuntimeContext,
): (line: string) => [string[], string] {
  return (line: string) => {
    const context = getContext();
    const modelCompletion = buildModelCompletions(
      line,
      getModelCatalog(context.profile).map((entry) => entry.id),
    );
    if (modelCompletion) {
      return modelCompletion;
    }

    const modeCompletion = buildModeCompletions(line);
    if (modeCompletion) {
      return modeCompletion;
    }

    const commandCompletion = buildSlashCommandCompletions(line);
    if (commandCompletion) {
      return commandCompletion;
    }

    return [[], line];
  };
}

async function onboardProfile(
  existing?: ProviderProfileMeta,
  rl?: ReadlineInterface,
): Promise<ResolvedProviderProfile | null> {
  const kind = await chooseProviderKind(existing?.kind, rl);
  if (!kind) {
    return null;
  }

  const name = await promptText("Profile name", existing?.name ?? "", rl);
  if (!name) {
    return null;
  }

  const baseUrl = await promptText(
    kind === "gemini"
      ? "Base URL (blank for official Gemini API)"
      : kind === "openai-compatible"
        ? "Base URL"
      : "Base URL (optional)",
    existing?.baseUrl ?? "",
    rl,
  );
  const region =
    kind === "bedrock"
      ? await promptText("AWS region", existing?.region ?? "", rl)
      : undefined;
  const awsProfile =
    kind === "bedrock"
      ? await promptText("AWS profile (optional)", existing?.awsProfile ?? "", rl)
      : undefined;
  const extraHeaders = await parseHeadersInput(existing?.extraHeaders, rl);

  const apiKey =
    kind !== "bedrock"
      ? await promptText("API key", "", rl)
      : undefined;
  const accessKeyId =
    kind === "bedrock"
      ? await promptText("AWS access key id (optional)", "", rl)
      : undefined;
  const secretAccessKey =
    kind === "bedrock"
      ? await promptText("AWS secret access key (optional)", "", rl)
      : undefined;
  const sessionToken =
    kind === "bedrock"
      ? await promptText("AWS session token (optional)", "", rl)
      : undefined;

  const now = new Date().toISOString();
  const meta: ProviderProfileMeta = {
    id: existing?.id ?? createProfileId(),
    name,
    kind,
    enabled: existing?.enabled ?? true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(baseUrl ? { baseUrl } : {}),
    ...(region ? { region } : {}),
    ...(awsProfile ? { awsProfile } : {}),
    ...(extraHeaders ? { extraHeaders } : {}),
  };

  upsertProfile(meta);
  const storage = await setProfileSecrets(meta.id, {
    ...(apiKey ? { apiKey } : {}),
    ...(accessKeyId ? { accessKeyId } : {}),
    ...(secretAccessKey ? { secretAccessKey } : {}),
    ...(sessionToken ? { sessionToken } : {}),
  });

  if (kind === "openai-compatible") {
    const transport = await chooseOption(
      "Transport mode",
      [
        { label: "auto", value: "auto" as const },
        { label: "responses", value: "responses" as const },
        { label: "chat", value: "chat" as const },
      ],
      "auto",
      rl,
    );
    setTransportMode(meta.id, transport ?? "auto");
  }

  const resolved = await resolveActiveProfile(name);
  if (!resolved) {
    return null;
  }

  const adapter = getProviderAdapter(kind);
  const validation = await adapter.validateProfile(resolved);
  const validationTone =
    validation.ok && !validation.message.toLowerCase().includes("partial")
      ? "success"
      : validation.ok
        ? "warning"
        : "danger";
  printPanel(
    validationTone === "success" ? "Profile Check Passed" : "Profile Check",
    [
      ...renderKeyValueRows([
        { label: "Profile", value: resolved.meta.name },
        {
          label: "Provider",
          value: `${adapter.displayName} (${resolved.meta.kind})`,
        },
        {
          label: "Secret storage",
          value: storage.storage === "dpapi" ? "DPAPI" : "local secrets file",
        },
      ]),
      "",
      validation.message,
    ],
    validationTone,
  );

  try {
    const models = await refreshModelsForProfile(resolved);
    if (models.length) {
      printPanel(
        "Models Synced",
        [
          ...renderKeyValueRows([
            { label: "Profile", value: resolved.meta.name },
            { label: "Count", value: models.length },
          ]),
          "",
          "Choose the default model for this profile.",
        ],
        "success",
      );
      const model = await chooseModelInteractive(resolved, undefined, rl);
      setDefaultModel(resolved.meta.id, model);
    } else {
      printPanel(
        "No Models Returned",
        [
          "The provider did not return any models for this profile.",
          "Enter a model id manually to keep going.",
        ],
        "warning",
      );
      const manual = await promptText(
        "Models lookup returned nothing. Enter a model id",
        "",
        rl,
      );
      if (manual) {
        setManualModels(resolved.meta.id, [
          {
            id: manual,
            label: manual,
            provider: resolved.meta.kind,
            source: "manual",
          },
        ]);
        setDefaultModel(resolved.meta.id, manual);
      }
    }
  } catch (error) {
    printPanel(
      "Model Listing Failed",
      [
        `Detail: ${error instanceof Error ? error.message : String(error)}`,
        "",
        "Enter one or more model ids manually to continue.",
      ],
      "warning",
    );
    const manual = await promptText(
      "Enter one or more model ids (comma separated)",
      "",
      rl,
    );
    if (manual) {
      const models = manual
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
        .map((value) => ({
          id: value,
          label: value,
          provider: resolved.meta.kind,
          source: "manual" as const,
        }));
      if (models.length) {
        setManualModels(resolved.meta.id, models);
        const firstModel = models[0];
        if (firstModel) {
          setDefaultModel(resolved.meta.id, firstModel.id);
        }
      }
    }
  }

  setActiveProfile(resolved.meta.id);
  return resolveActiveProfile(resolved.meta.name);
}

async function openProvidersMenu(
  rl?: ReadlineInterface,
): Promise<ResolvedProviderProfile | null> {
  while (true) {
    const settings = getSettings();
    const nameWidth = Math.max(
      7,
      ...settings.providerProfiles.map((profile) => profile.name.length),
    );
    const providerRows =
      settings.providerProfiles.length > 0
        ? settings.providerProfiles.map((profile) => {
            const active = settings.activeProfileId === profile.id ? "*" : " ";
            const status = profile.enabled ? "enabled" : "disabled";
            return `${active} ${profile.name.padEnd(nameWidth)}  ${profile.kind}  ${status}`;
          })
        : [
            "No provider profiles configured yet.",
            "Add a profile to start chatting.",
          ];

    printPanel("Providers", providerRows, "primary");

    const action = await chooseOption(
      "Provider action",
      [
        { label: "Add profile", value: "add" },
        { label: "Edit profile", value: "edit" },
        { label: "Activate profile", value: "activate" },
        { label: "Delete profile", value: "delete" },
        { label: "Refresh models", value: "refresh" },
        { label: "Back", value: "back" },
      ],
      "add",
      rl,
    );

    if (!action || action === "back") {
      return resolveActiveProfile();
    }

    if (action === "add") {
      const resolved = await onboardProfile(undefined, rl);
      if (resolved) {
        return resolved;
      }
      continue;
    }

    const settingsNow = getSettings();
    if (!settingsNow.providerProfiles.length) {
      printPanel(
        "No Profiles Available",
        ["There are no provider profiles to edit yet."],
        "warning",
      );
      continue;
    }

    const selected = await chooseOption(
      "Choose profile",
      settingsNow.providerProfiles.map((profile) => ({
        label: `${profile.name} (${profile.kind})`,
        value: profile.id,
      })),
      settingsNow.activeProfileId,
      rl,
    );

    const profile = settingsNow.providerProfiles.find(
      (entry) => entry.id === selected,
    );
    if (!profile) {
      continue;
    }

    if (action === "edit") {
      const resolved = await onboardProfile(profile, rl);
      if (resolved) {
        return resolved;
      }
      continue;
    }

    if (action === "activate") {
      setActiveProfile(profile.id);
      return resolveActiveProfile(profile.name);
    }

    if (action === "delete") {
      if (
        await promptConfirm(`Delete profile "${profile.name}"?`, false, rl)
      ) {
        deleteProfile(profile.id);
        deleteProfileSecrets(profile.id);
      }
      continue;
    }

    if (action === "refresh") {
      const resolved = await resolveActiveProfile(profile.name);
      if (resolved) {
        try {
          const models = await refreshModelsForProfile(resolved);
          printPanel(
            "Models Refreshed",
            [
              ...renderKeyValueRows([
                { label: "Profile", value: resolved.meta.name },
                { label: "Count", value: models.length },
              ]),
            ],
            "success",
          );
        } catch (error) {
          printPanel(
            "Model Refresh Failed",
            [`Detail: ${error instanceof Error ? error.message : String(error)}`],
            "danger",
          );
        }
      }
    }
  }
}

async function openConfigMenu(rl?: ReadlineInterface): Promise<void> {
  while (true) {
    const settings = getSettings();
    printPanel(
      "Config",
      [
        ...renderKeyValueRows([
          { label: "Browser", value: settings.browser.enabled ? "enabled" : "disabled" },
          { label: "Search endpoint", value: settings.search.endpoint },
          { label: "Agent mode", value: settings.agents.defaultMode },
        ]),
      ],
      "info",
    );

    const action = await chooseOption(
      "Config action",
      [
        { label: "Toggle browser", value: "browser" },
        { label: "Search settings", value: "search" },
        { label: "Default agent mode", value: "agent" },
        { label: "Back", value: "back" },
      ],
      "back",
      rl,
    );

    if (!action || action === "back") {
      return;
    }

    if (action === "browser") {
      updateSettings((current) => ({
        ...current,
        browser: {
          ...current.browser,
          enabled: !current.browser.enabled,
        },
      }));
      continue;
    }

    if (action === "search") {
      const endpoint = await promptText(
        "Search endpoint",
        settings.search.endpoint,
        rl,
      );
      const headerName = await promptText(
        "Header name",
        settings.search.headerName,
        rl,
      );
      const headerPrefix = await promptText(
        "Header prefix",
        settings.search.headerPrefix,
        rl,
      );
      const apiKey = await promptText("Search API key (optional)", "", rl);

      updateSettings((current) => ({
        ...current,
        search: {
          ...current.search,
          ...(endpoint ? { endpoint } : {}),
          ...(headerName ? { headerName } : {}),
          ...(headerPrefix !== undefined ? { headerPrefix } : {}),
        },
      }));

      if (apiKey) {
        await saveSearchApiKey(apiKey);
      }
      continue;
    }

    if (action === "agent") {
      const selectedMode = await chooseOption(
        "Default agent mode",
        [
          { label: "background", value: "background" as const },
          { label: "worktree", value: "worktree" as const },
          { label: "tmux", value: "tmux" as const },
        ],
        settings.agents.defaultMode,
        rl,
      );
      if (selectedMode) {
        updateSettings((current) => ({
          ...current,
          agents: {
            ...current.agents,
            defaultMode: selectedMode,
          },
        }));
      }
    }
  }
}

async function openBrowserMenu(rl?: ReadlineInterface): Promise<void> {
  const browser = getBrowserSession();
  printPanel(
    "Browser Status",
    toPrettyJson(await browser.getStatus()).split(/\r?\n/),
    "info",
  );
  const url = await promptText("Open URL (leave blank to exit)", "", rl);
  if (url) {
    printPanel(
      "Browser Result",
      toPrettyJson(await browser.open(url)).split(/\r?\n/),
      "success",
    );
  }
}

function toPrettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function ensureProfile(
  requestedProfile?: string,
  rl?: ReadlineInterface,
): Promise<ResolvedProviderProfile> {
  let profile = await resolveActiveProfile(requestedProfile);
  if (profile) {
    return profile;
  }

  printPanel(
    "Provider Required",
    ["No provider profile is configured yet. Add one to continue."],
    "warning",
  );
  const created = await openProvidersMenu(rl);
  if (!created) {
    throw new Error("A provider profile is required.");
  }
  profile = created;
  return profile;
}

function createInteractiveToolHandlers(
  rl?: ReadlineInterface,
  renderer?: TurnRenderer,
): NonNullable<NonNullable<RuntimeContext["session"]["toolContext"]["interactive"]>> {
  return {
    requestUserInput: async (request: UserInputRequest) => {
      renderer?.close();
      return promptUserInputRequestInteractive(request, rl);
    },
    submitTaskPlan: async (plan: PendingTaskPlan) => {
      renderer?.close();
      return promptTaskPlanApprovalInteractive(plan, rl);
    },
  };
}

async function runChatTurn(
  context: RuntimeContext,
  userInput: string,
  rl?: ReadlineInterface,
  silent = false,
): Promise<string> {
  const renderer = silent
    ? undefined
    : new TurnRenderer({
        profileName: context.profile.meta.name,
        providerKind: context.profile.meta.kind,
        model: context.model,
        interactionMode: context.interactionMode,
        getTaskPhase: () => context.session.getTaskState()?.phase,
        transport: getTransportLabel(context.profile),
        output: stdout,
      });

  try {
    context.session.toolContext.interactive = createInteractiveToolHandlers(
      rl,
      renderer,
    );
    const result = await context.session.send(
      userInput,
      renderer
        ? async (event: UnifiedStreamEvent) => {
            renderer.handle(event);
          }
        : undefined,
    );
    return collectText(result.assistantMessage.parts);
  } finally {
    delete context.session.toolContext.interactive;
    renderer?.close();
  }
}

async function rebuildContext(
  current: RuntimeContext,
  requestedProfile?: string,
  requestedModel?: string,
): Promise<RuntimeContext> {
  const profile = await ensureProfile(requestedProfile);
  const model =
    requestedModel || (await chooseModelInteractive(profile, requestedModel));
  return {
    ...current,
    profile,
    model,
    session: buildChatSession(
      profile,
      model,
      current.cwd,
      current.interactionMode,
      current.systemPromptBase,
      current.browser,
      current.agents,
    ),
  };
}

async function handleSlashCommand(
  line: string,
  context: RuntimeContext,
  rl: ReadlineInterface,
): Promise<RuntimeContext | null> {
  const [command = "", ...rest] = line.trim().split(/\s+/);

  switch (command) {
    case "/":
    case "/help":
      printHelpPanel();
      return context;
    case "/providers": {
      const profile = await openProvidersMenu(rl);
      if (!profile) {
        return context;
      }
      const model =
        resolveModelForProfile(profile) ??
        (await chooseModelInteractive(profile, undefined, rl));
      return {
        ...context,
        profile,
        model,
        session: buildChatSession(
          profile,
          model,
          context.cwd,
          context.interactionMode,
          context.systemPromptBase,
          context.browser,
          context.agents,
        ),
      };
    }
    case "/status":
      printStatusPanel(context);
      return context;
    case "/model": {
      const requestedModel = rest.join(" ").trim();
      const model = requestedModel
        ? setModelDirectly(context.profile, requestedModel)
        : await chooseModelInteractive(
            context.profile,
            context.model,
            rl,
          );
      printPanel(
        "Model Updated",
        [
          ...renderKeyValueRows([
            { label: "Profile", value: context.profile.meta.name },
            { label: "Model", value: model },
          ]),
        ],
        "success",
      );
      return {
        ...context,
        model,
        session: buildChatSession(
          context.profile,
          model,
          context.cwd,
          context.interactionMode,
          context.systemPromptBase,
          context.browser,
          context.agents,
        ),
      };
    }
    case "/mode": {
      const raw = rest.join(" ").trim();
      const requestedMode = raw ? parseInteractionMode(raw) : undefined;
      if (raw && !requestedMode) {
        printPanel(
          "Unknown Mode",
          [
            `Mode "${raw}" does not exist.`,
            "Use /mode to pick one interactively.",
            "",
            "Available modes",
            ...listInteractionModes().map(
              (mode) => `- ${mode.label} (${mode.promptTag})`,
            ),
          ],
          "warning",
        );
        return context;
      }

      const nextMode =
        requestedMode ??
        (await chooseInteractionMode(context.interactionMode, rl));
      if (!nextMode) {
        return context;
      }

      const next = applyInteractionMode(context, nextMode);
      const definition = getInteractionModeDefinition(nextMode);
      printPanel(
        "Mode Updated",
        [
          ...renderKeyValueRows([
            { label: "Mode", value: definition.label },
            { label: "Prompt tag", value: definition.promptTag },
          ]),
          "",
          definition.detail,
          "Shift+Tab cycles the mode directly from the main prompt.",
        ],
        "success",
      );
      return next;
    }
    case "/config":
      await openConfigMenu(rl);
      return context;
    case "/browser":
      await openBrowserMenu(rl);
      return context;
    case "/clear":
      printPanel(
        "Conversation Cleared",
        ["Started a fresh conversation for the current profile and model."],
        "success",
      );
      return {
        ...context,
        session: buildChatSession(
          context.profile,
          context.model,
          context.cwd,
          context.interactionMode,
          context.systemPromptBase,
          context.browser,
          context.agents,
        ),
      };
    case "/exit":
    case "/quit":
      return null;
    default:
      const suggestions = findSlashCommandSuggestions(command, 4);
      printPanel(
        "Unknown Command",
        [
          `Slash command "${command}" does not exist.`,
          "Use /help to see the available commands.",
          ...(suggestions.length > 0
            ? [
                "",
                "Closest matches",
                ...renderCommandRows(suggestions),
              ]
            : []),
        ],
        "warning",
      );
      if (rest.length > 0) {
        stdout.write(`${formatDim(rest.join(" "))}\n`);
      }
      return context;
  }
}

async function readReplLine(rl: ReadlineInterface, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const onLine = (line: string): void => {
      cleanup();
      resolve(line);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("readline was closed"));
    };
    const cleanup = (): void => {
      rl.off("line", onLine);
      rl.off("close", onClose);
    };

    rl.once("line", onLine);
    rl.once("close", onClose);
    refreshActivePrompt(rl, prompt);
  });
}

async function startRepl(context: RuntimeContext): Promise<void> {
  printSessionSummary(context, true);

  let current = context;
  let mainPromptActive = false;
  let rl: ReadlineInterface | undefined;
  const inputRouter = createReplInputRouter(() => {
    if (!mainPromptActive || !rl) {
      return;
    }

    current = applyInteractionMode(
      current,
      getNextInteractionMode(current.interactionMode),
    );
    refreshActivePrompt(rl, buildPromptText(current));
  });

  rl = createInterface({
    input: inputRouter.input,
    output: stdout,
    terminal: Boolean(stdout.isTTY),
    completer: buildReplCompleter(() => current),
  });

  try {
    while (true) {
      let line: string;
      try {
        mainPromptActive = true;
        line = await readReplLine(rl, buildPromptText(current));
      } catch (error) {
        const message = getErrorMessage(error).toLowerCase();
        if (message.includes("readline was closed")) {
          break;
        }
        throw error;
      } finally {
        mainPromptActive = false;
      }

      const input = line.trim();
      if (!input) {
        continue;
      }

      if (input.startsWith("/")) {
        const next = await handleSlashCommand(input, current, rl);
        if (!next) {
          break;
        }
        current = next;
        continue;
      }

      try {
        const output = await runChatTurn(current, input, rl);
        if (!output.trim()) {
          printNoOutputPanel(current);
        }
      } catch (error) {
        printRuntimeErrorPanel(error, current);
      }
    }
  } finally {
    rl?.close();
    inputRouter.dispose();
  }
}

async function runAgentWorker(agentId: string): Promise<void> {
  const agents = new AgentManager();
  const record = agents.readAgent(agentId);
  if (!record) {
    throw new Error(`Agent ${agentId} not found.`);
  }

  try {
    agents.updateStatus(agentId, {
      status: "running",
    });
    const profile = await ensureProfile(record.profileName);
    const browser = getBrowserSession();
    const session = buildChatSession(
      profile,
      record.model,
      record.cwd,
      record.interactionMode ?? "task",
      undefined,
      browser,
      agents,
      record.taskPhase ?? "executing",
      false,
    );

    let lastResultText = await session.send(record.task).then((result) => {
      return collectText(result.assistantMessage.parts);
    });

    let idleSince = Date.now();
    while (Date.now() - idleSince < 1500) {
      const inbox = agents.consumeInbox(agentId);
      if (!inbox.length) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        continue;
      }

      for (const message of inbox) {
        lastResultText = await session.send(message.text).then((result) => {
          return collectText(result.assistantMessage.parts);
        });
      }
      idleSince = Date.now();
    }

    agents.updateStatus(agentId, {
      status: "completed",
      resultText: lastResultText,
    });
  } catch (error) {
    agents.updateStatus(agentId, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function runRootAction(
  promptParts: string[],
  options: RootOptions,
): Promise<void> {
  const profile = await ensureProfile(options.profile);
  const model =
    resolveModelForProfile(profile, options.model) ??
    (await chooseModelInteractive(profile, options.model));
  const browser = getBrowserSession();
  const agents = new AgentManager();
  const requestedMode = parseInteractionMode(options.mode);
  if (options.mode?.trim() && !requestedMode) {
    throw new Error(
      `Unknown mode "${options.mode}". Use "chat-edit" or "task".`,
    );
  }
  const interactionMode = requestedMode ?? DEFAULT_INTERACTION_MODE;
  const systemPromptBase = options.system?.trim() || undefined;
  const context: RuntimeContext = {
    cwd: processCwd(),
    profile,
    model,
    interactionMode,
    systemPromptBase,
    browser,
    agents,
    session: buildChatSession(
      profile,
      model,
      processCwd(),
      interactionMode,
      systemPromptBase,
      browser,
      agents,
    ),
  };

  if (promptParts.length > 0) {
    printSessionSummary(context);
    try {
      const output = await runChatTurn(context, promptParts.join(" "));
      if (!output.trim()) {
        printNoOutputPanel(context);
      }
    } catch (error) {
      printRuntimeErrorPanel(error, context);
      process.exitCode = 1;
    }
    return;
  }

  await startRepl(context);
}

async function withPromptReader<T>(
  rl: ReadlineInterface | undefined,
  fn: (reader: ReadlineInterface) => Promise<T>,
): Promise<T> {
  if (rl) {
    return fn(rl);
  }

  const temp = createInterface({
    input: stdin,
    output: stdout,
  });
  try {
    return await fn(temp);
  } finally {
    temp.close();
  }
}

async function chooseOption<T>(
  message: string,
  options: SelectOption<T>[],
  defaultValue?: T,
  rl?: ReadlineInterface,
  config?: {
    allowBlank?: boolean;
    promptHint?: string | undefined;
  },
): Promise<T | undefined> {
  return withPromptReader(rl, async (reader) => {
    const allowBlank = config?.allowBlank ?? true;
    const promptHint =
      config?.promptHint ??
      (allowBlank ? "[number, blank for default]" : "[number or action]");

    printPanel(
      message,
      options.map((option, index) => {
        const isDefault =
          defaultValue !== undefined && option.value === defaultValue;
        return `${String(index + 1).padStart(2, " ")}. ${option.label}${isDefault ? " [default]" : ""}`;
      }),
      "primary",
    );

    while (true) {
      const answer = (await reader.question(
        `${formatLabel("Choose")} ${formatDim(promptHint)}: `,
      )).trim();

      if (!answer) {
        if (!allowBlank) {
          stdout.write(
            `${formatWarning("Choose 1, 2, or 3, or type the action name.")}\n`,
          );
          continue;
        }
        if (defaultValue !== undefined) {
          return defaultValue;
        }
        if (options[0]) {
          return options[0].value;
        }
        return undefined;
      }

      const matched = findSelectedOption(answer, options);
      if (matched) {
        return matched.value;
      }

      stdout.write(`${formatWarning("Invalid choice, try again.")}\n`);
    }
  });
}

export async function runCli(): Promise<void> {
  const program = new Command();

  program
    .name("moecli")
    .description("MoeCli - pink-themed multi-provider coding CLI")
    .argument("[prompt...]", "optional one-shot prompt")
    .option("-p, --profile <name>", "provider profile name")
    .option("-m, --model <id>", "override model")
    .option("--mode <chat-edit|task>", "set the interaction mode")
    .option("-s, --system <text>", "override system prompt")
    .action(async (promptParts: string[], options: RootOptions) => {
      await runRootAction(promptParts, options);
    });

  program
    .command("providers")
    .description("open the local providers menu")
    .action(async () => {
      await openProvidersMenu();
    });

  program
    .command("browser")
    .description("show browser integration status")
    .action(async () => {
      await openBrowserMenu();
    });

  program
    .command("agent-run")
    .description("internal agent worker entrypoint")
    .requiredOption("--agent-id <id>")
    .action(async (options: { agentId: string }) => {
      await runAgentWorker(options.agentId);
    });

  await program.parseAsync(process.argv);
}
