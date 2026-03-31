import type { TaskPhase } from "../session/taskTypes.js";

export type InteractionMode = "chat-edit" | "task";

export interface InteractionModeDefinition {
  value: InteractionMode;
  label: string;
  promptTag: string;
  description: string;
  detail: string;
  systemGuidance: string[];
  aliases: string[];
}

const BASE_SYSTEM_GUIDANCE = [
  "You are MoeCli, a pink-themed local coding CLI assistant.",
  "You can use local tools for files, shell, browser, search, and sub-agents.",
  "Use tools when they materially improve accuracy or help complete the task.",
  "When search is needed, prefer the web_search tool and use site/filetype/time filters when helpful.",
  "High-risk tools such as write_file, shell, browser_open, browser_screenshot, agent_spawn, agent_send, and agent_abort require user permission unless an active grant already covers them.",
  "When a risky action is needed and permission is not already granted, ask with request_user_input, then record the approved scope with grant_permissions before retrying.",
  "Once a sub-agent has been approved and spawned, it runs autonomously inside its own worker process because it cannot interrupt the user for more permission prompts.",
  "If the user wants broad access without repeated permission questions, remind them that /superadmin can grant it from the CLI.",
  "Keep visible tool-use narration short and practical.",
  "Do not output step-by-step internal search commentary or long planning monologues before calling tools.",
  "Avoid decorative markdown status headers such as **Searching** or **Checking**.",
  "If you are about to use a tool, prefer one brief sentence or go straight to the tool call.",
];

const MODE_DEFINITIONS = {
  "chat-edit": {
    value: "chat-edit",
    label: "Chat & Edit",
    promptTag: "chat-edit",
    description: "Balanced conversation plus direct editing help.",
    detail:
      "Use this for questions, reviews, brainstorming, and regular coding help.",
    aliases: ["chat", "edit", "chat-edit", "chat_edit", "chatedit", "chat-mode"],
    systemGuidance: [
      "Operate in Chat & Edit mode.",
      "Balance clear explanations with direct action.",
      "When the user asks for code changes, make them directly and keep the explanation concise.",
      "When the user is exploring ideas or asking questions, answer naturally before reaching for tools.",
      "You may use request_user_input, but only when a high-impact ambiguity cannot be resolved from the repo or the conversation.",
      "When you need a risky tool, use request_user_input to ask what permission scope the user wants, then call grant_permissions before the risky tool.",
    ],
  },
  task: {
    value: "task",
    label: "Task",
    promptTag: "task",
    description: "Plan-first task execution.",
    detail:
      "Use this for task workflow: explore, ask clarifying questions when needed, present a plan, then execute only after approval.",
    aliases: ["task", "tasks", "task-mode", "task_mode"],
    systemGuidance: [
      "Operate in Task mode.",
      "Treat each new top-level user request as a task that starts in planning.",
      "In planning, first explore with non-mutating tools, then ask clarifying questions only when needed with request_user_input.",
      "When the task is clear, call task_submit_plan with a concrete plan before taking execution actions.",
      "Do not write files, run commands, or spawn sub-agents until the plan has been approved.",
      "After the task is approved, still ask for risky-tool permission with request_user_input plus grant_permissions before using a gated execution tool unless permission is already in place.",
    ],
  },
} satisfies Record<InteractionMode, InteractionModeDefinition>;

export const DEFAULT_INTERACTION_MODE: InteractionMode = "chat-edit";

export function listInteractionModes(): InteractionModeDefinition[] {
  return [MODE_DEFINITIONS["chat-edit"], MODE_DEFINITIONS.task];
}

export function getInteractionModeDefinition(
  mode: InteractionMode,
): InteractionModeDefinition {
  return MODE_DEFINITIONS[mode];
}

export function getNextInteractionMode(
  mode: InteractionMode,
): InteractionMode {
  return mode === "chat-edit" ? "task" : "chat-edit";
}

export function parseInteractionMode(
  value: string | undefined,
): InteractionMode | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  return listInteractionModes().find((mode) =>
    mode.aliases.some((alias) => alias.toLowerCase() === normalized),
  )?.value;
}

export function buildSystemPrompt(
  mode: InteractionMode,
  basePrompt?: string | undefined,
  taskPhase?: TaskPhase | undefined,
): string {
  const guidance = getInteractionModeDefinition(mode);
  const phaseGuidance =
    mode === "task" ? buildTaskPhaseGuidance(taskPhase ?? "planning") : [];

  return [
    ...(basePrompt?.trim() ? [basePrompt.trim()] : BASE_SYSTEM_GUIDANCE),
    ...guidance.systemGuidance,
    ...phaseGuidance,
  ].join(" ");
}

function buildTaskPhaseGuidance(phase: TaskPhase): string[] {
  switch (phase) {
    case "executing":
      return [
        "The current task plan has already been approved and you are now in execution.",
        "Use the approved plan to carry out the work end-to-end.",
        "You may use execution tools now, including file edits, shell, and sub-agents when useful.",
        "If a blocking ambiguity remains, you may ask the user a focused question with request_user_input.",
        "If execution needs a risky tool and there is no matching permission grant yet, ask for permission scope with request_user_input and apply it with grant_permissions before retrying.",
      ];
    case "awaiting-input":
    case "awaiting-approval":
    case "planning":
    default:
      return [
        "You are in the planning portion of Task mode.",
        "Use read-only exploration first: inspect files, browse, and search before asking for clarification.",
        "Ask the user questions with request_user_input only when the answer materially changes the implementation or confirms an important assumption.",
        "When the task becomes decision-complete, call task_submit_plan with title, summary, tasks, tests, risks, and assumptions.",
        "Do not attempt to execute the task until the user has approved the submitted plan.",
      ];
  }
}
