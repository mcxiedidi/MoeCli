import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, join, resolve } from "node:path";
import type {
  ResolvedProviderProfile,
  UnifiedToolCall,
  UnifiedToolDefinition,
} from "../providers/types.js";
import type { InteractionMode } from "../cli/interactionMode.js";
import {
  PendingTaskPlanSchema,
  UserInputRequestSchema,
  type PendingTaskPlan,
  type TaskModeState,
  type TaskPlanDecision,
  type UserInputRequest,
  type UserInputResult,
  isTaskPlanningPhase,
} from "../session/taskTypes.js";
import { safeJsonParse, toPrettyJson } from "../utils/json.js";
import { getSettings } from "../config/settings.js";
import { getProfileSecrets, setProfileSecrets } from "../config/secrets.js";
import { BrowserSession } from "../browser/session.js";
import { AgentManager } from "../agents/manager.js";
import {
  buildToolApprovalRequest,
  clearToolPermissionState,
  consumeToolCallApproval,
  isApprovalRequiredTool,
  listApprovalRequiredTools,
  type ToolApprovalRequest,
  type ToolPermissionState,
} from "./permissions.js";

const execAsync = promisify(exec);
const SEARCH_SECRET_PROFILE_ID = "__moecli_search__";
const PLANNING_TOOL_NAMES = new Set([
  "read_file",
  "list_files",
  "web_search",
  "browser_status",
  "browser_snapshot",
  "browser_open",
  "request_user_input",
  "grant_permissions",
  "task_submit_plan",
]);
const NON_TASK_TOOL_NAMES = new Set(["task_submit_plan"]);

export interface ToolExecutionContext {
  cwd: string;
  profile: ResolvedProviderProfile;
  model: string;
  interactionMode: InteractionMode;
  taskState?: TaskModeState | undefined;
  browser: BrowserSession;
  agents: AgentManager;
  permissions?: ToolPermissionState | undefined;
  interactive?: {
    requestUserInput?: (
      request: UserInputRequest,
    ) => Promise<UserInputResult>;
    submitTaskPlan?: (
      plan: PendingTaskPlan,
    ) => Promise<TaskPlanDecision>;
  };
}

export interface ToolExecutionResult {
  output: string;
  isError?: boolean | undefined;
  control?: {
    restartLoop?: boolean | undefined;
    resetToolTurns?: boolean | undefined;
    endTurnText?: string | undefined;
  };
}

function resolveToolPath(baseCwd: string, rawPath: string): string {
  return isAbsolute(rawPath) ? rawPath : resolve(baseCwd, rawPath);
}

function truncate(text: string, limit = 20_000): string {
  return text.length > limit ? `${text.slice(0, limit)}\n...[truncated]` : text;
}

function listDirectory(
  startPath: string,
  recursive: boolean,
  depth = 3,
  prefix = "",
): string[] {
  const entries = readdirSync(startPath, { withFileTypes: true });
  const output: string[] = [];

  for (const entry of entries.slice(0, 200)) {
    const marker = entry.isDirectory() ? "/" : "";
    output.push(`${prefix}${entry.name}${marker}`);
    if (recursive && entry.isDirectory() && depth > 0) {
      output.push(
        ...listDirectory(
          join(startPath, entry.name),
          true,
          depth - 1,
          `${prefix}${entry.name}/`,
        ),
      );
    }
  }

  return output;
}

async function runSearchRequest(payload: Record<string, unknown>): Promise<string> {
  const settings = getSettings().search;
  if (!settings.enabled) {
    throw new Error("Search integration is disabled.");
  }

  const searchSecrets = await getProfileSecrets(SEARCH_SECRET_PROFILE_ID);
  const apiKey = searchSecrets.apiKey?.trim() || process.env.MOECLI_SEARCH_API_KEY;
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };

  if (apiKey && settings.headerName.trim()) {
    headers[settings.headerName] = `${settings.headerPrefix}${apiKey}`;
  }

  const response = await fetch(settings.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(text);
  }

  return truncate(text);
}

function isToolAvailableInContext(
  name: string,
  context: ToolExecutionContext,
): boolean {
  if (context.interactionMode !== "task") {
    return !NON_TASK_TOOL_NAMES.has(name);
  }

  const phase = context.taskState?.phase ?? "planning";
  if (isTaskPlanningPhase(phase)) {
    return PLANNING_TOOL_NAMES.has(name);
  }

  return name !== "task_submit_plan";
}

function formatToolUnavailableMessage(
  name: string,
  context: ToolExecutionContext,
): string {
  if (context.interactionMode !== "task") {
    return `Tool ${name} is unavailable outside Task mode.`;
  }

  const phase = context.taskState?.phase ?? "planning";
  if (isTaskPlanningPhase(phase)) {
    return `Tool ${name} is unavailable during task planning. Explore first, ask the user questions if needed, and submit a plan before execution.`;
  }

  return `Tool ${name} is unavailable in the current task phase.`;
}

function serializeStructuredResult(value: unknown): string {
  return truncate(JSON.stringify(value, null, 2));
}

function buildUserInputAnswersById(result: UserInputResult): UserInputResult["answersById"] {
  return result.answers.reduce<UserInputResult["answersById"]>((acc, answer) => {
    acc[answer.id] = {
      question: answer.question,
      ...(answer.selectedOption ? { selectedOption: answer.selectedOption } : {}),
      ...(answer.freeformText ? { freeformText: answer.freeformText } : {}),
    };
    return acc;
  }, {});
}

function buildPermissionRequiredResult(
  request: ToolApprovalRequest,
): ToolExecutionResult {
  const suggestedOptions = [
    {
      label: "Allow once",
      description: "Only allow this risky action one time.",
    },
    {
      label: "Allow this tool for the session",
      description: `Keep allowing ${request.toolName} until the session ends.`,
    },
    ...(request.toolName === "shell" && request.shellCommandPrefix
      ? [
          {
            label: `Allow "${request.shellCommandPrefix}" commands`,
            description:
              "Keep allowing this shell command prefix for the session.",
          },
        ]
      : []),
    {
      label: "Deny",
      description: "Do not allow this risky action right now.",
    },
  ];

  return {
    output: serializeStructuredResult({
      status: "permission_required",
      tool: request.toolName,
      action: request.summary,
      message:
        "Ask the user with request_user_input which permission scope to grant, then call grant_permissions before retrying this tool.",
      suggested_scopes:
        request.toolName === "shell" && request.shellCommandPrefix
          ? ["once", "tool", "shell-prefix", "session"]
          : ["once", "tool", "session"],
      ...(request.commandText ? { command_text: request.commandText } : {}),
      ...(request.shellCommandPrefix
        ? { shell_prefix: request.shellCommandPrefix }
        : {}),
      suggested_question: {
        header: "Permission",
        id: "permission_scope",
        question: `I need permission before I can continue: ${request.summary}. Which scope should I use?`,
        options: suggestedOptions,
      },
      ...(request.toolName === "agent_spawn"
        ? {
            note:
              "A spawned sub-agent runs autonomously inside its own worker process because it cannot ask the user for follow-up permission prompts.",
          }
        : {}),
      superadmin_hint:
        "If the user wants broad access without repeated questions, tell them to use /superadmin.",
    }),
    isError: true,
  };
}

function requirePermissionState(
  state: ToolPermissionState | undefined,
): ToolPermissionState {
  if (!state) {
    throw new Error("Permission state is unavailable in this session.");
  }

  return state;
}

export async function saveSearchApiKey(apiKey: string): Promise<void> {
  await setProfileSecrets(SEARCH_SECRET_PROFILE_ID, { apiKey });
}

export function getBuiltInTools(): UnifiedToolDefinition[] {
  return [
    {
      name: "read_file",
      description: "Read a local file from disk.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
        required: ["path"],
      },
    },
    {
      name: "list_files",
      description: "List files in a directory.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          recursive: { type: "boolean" },
          depth: { type: "number" },
        },
        required: ["path"],
      },
    },
    {
      name: "write_file",
      description: "Write or append a file on disk.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
          append: { type: "boolean" },
        },
        required: ["path", "content"],
      },
    },
    {
      name: "shell",
      description: "Execute a shell command locally.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: { type: "string" },
          timeoutMs: { type: "number" },
        },
        required: ["command"],
      },
    },
    {
      name: "web_search",
      description:
        "Search the web with the configured search endpoint. Supports site, filetype, sort, and time_range filters.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          site: { type: "string" },
          filetype: { type: "string" },
          fetch_full: { type: "boolean" },
          sort: { type: "string", enum: ["relevance", "date"] },
          time_range: {
            type: "string",
            enum: ["day", "week", "month", "year"],
          },
        },
        required: ["query"],
      },
    },
    {
      name: "browser_status",
      description: "Inspect local browser integration status.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "browser_open",
      description: "Open a URL in the local browser session.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
        },
        required: ["url"],
      },
    },
    {
      name: "browser_snapshot",
      description: "Capture page text from the browser session.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
        },
      },
    },
    {
      name: "browser_screenshot",
      description: "Capture a browser screenshot to disk.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
        },
      },
    },
    {
      name: "request_user_input",
      description:
        "Ask the user one to three structured questions when an important ambiguity or permission decision must be resolved before proceeding.",
      inputSchema: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            items: {
              type: "object",
              properties: {
                header: { type: "string" },
                id: { type: "string" },
                question: { type: "string" },
                options: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "object",
                    properties: {
                      label: { type: "string" },
                      description: { type: "string" },
                    },
                    required: ["label", "description"],
                  },
                },
              },
              required: ["header", "id", "question", "options"],
            },
          },
        },
        required: ["questions"],
      },
    },
    {
      name: "grant_permissions",
      description:
        "Record user-approved permission scopes for risky tools after request_user_input. Supports once, tool, shell-prefix, next-turn, session, and reset.",
      inputSchema: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["once", "tool", "shell-prefix", "next-turn", "session", "reset"],
          },
          tool: { type: "string" },
          shellPrefix: { type: "string" },
        },
        required: ["scope"],
      },
    },
    {
      name: "task_submit_plan",
      description:
        "Submit the proposed task plan for user approval before execution begins.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          tasks: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
          },
          tests: {
            type: "array",
            items: { type: "string" },
          },
          risks: {
            type: "array",
            items: { type: "string" },
          },
          assumptions: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["title", "summary", "tasks", "tests", "risks", "assumptions"],
      },
    },
    {
      name: "agent_spawn",
      description:
        "Spawn a local sub-agent in background, worktree, or tmux mode. Spawned agents run autonomously because they cannot ask the user for follow-up permissions directly.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string" },
          name: { type: "string" },
          mode: {
            type: "string",
            enum: ["background", "worktree", "tmux"],
          },
          cwd: { type: "string" },
        },
        required: ["task"],
      },
    },
    {
      name: "agent_send",
      description: "Send a follow-up message to a running sub-agent.",
      inputSchema: {
        type: "object",
        properties: {
          agentId: { type: "string" },
          message: { type: "string" },
        },
        required: ["agentId", "message"],
      },
    },
    {
      name: "agent_wait",
      description: "Wait for a sub-agent to finish and return its state.",
      inputSchema: {
        type: "object",
        properties: {
          agentId: { type: "string" },
          timeoutMs: { type: "number" },
        },
        required: ["agentId"],
      },
    },
    {
      name: "agent_abort",
      description: "Abort a running sub-agent.",
      inputSchema: {
        type: "object",
        properties: {
          agentId: { type: "string" },
        },
        required: ["agentId"],
      },
    },
  ];
}

export function getAvailableTools(
  tools: UnifiedToolDefinition[],
  context: ToolExecutionContext,
): UnifiedToolDefinition[] {
  return tools.filter((tool) => isToolAvailableInContext(tool.name, context));
}

export async function executeToolCall(
  call: UnifiedToolCall,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const input = safeJsonParse<Record<string, unknown>>(call.argumentsText) ?? {};

  try {
    if (!isToolAvailableInContext(call.name, context)) {
      throw new Error(formatToolUnavailableMessage(call.name, context));
    }

    if (isApprovalRequiredTool(call.name)) {
      const approvalRequest = buildToolApprovalRequest(call, input);
      const autoApproved = consumeToolCallApproval(
        context.permissions,
        approvalRequest,
      );

      if (!autoApproved) {
        return buildPermissionRequiredResult(approvalRequest);
      }
    }

    switch (call.name) {
      case "read_file": {
        const target = resolveToolPath(context.cwd, String(input.path ?? ""));
        const content = readFileSync(target, "utf8");
        return { output: truncate(content) };
      }
      case "list_files": {
        const target = resolveToolPath(context.cwd, String(input.path ?? "."));
        const recursive = Boolean(input.recursive);
        const depth =
          typeof input.depth === "number" && Number.isFinite(input.depth)
            ? input.depth
            : 3;
        return {
          output: listDirectory(target, recursive, depth).join("\n"),
        };
      }
      case "write_file": {
        const target = resolveToolPath(context.cwd, String(input.path ?? ""));
        const content = String(input.content ?? "");
        mkdirSync(resolve(target, ".."), { recursive: true });
        if (input.append) {
          writeFileSync(target, content, { encoding: "utf8", flag: "a" });
        } else {
          writeFileSync(target, content, "utf8");
        }
        return {
          output: `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${target}`,
        };
      }
      case "shell": {
        const command = String(input.command ?? "");
        const cwd =
          typeof input.cwd === "string" && input.cwd.trim()
            ? resolveToolPath(context.cwd, input.cwd)
            : context.cwd;
        const timeout =
          typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
            ? input.timeoutMs
            : 120_000;
        const { stdout, stderr } = await execAsync(command, {
          cwd,
          timeout,
          maxBuffer: 1024 * 1024,
          shell:
            process.platform === "win32"
              ? "powershell.exe"
              : process.env.SHELL || "/bin/sh",
        });
        return {
          output: truncate(
            [stdout, stderr ? `stderr:\n${stderr}` : ""]
              .filter(Boolean)
              .join("\n"),
          ),
        };
      }
      case "web_search": {
        const searchSettings = getSettings().search;
        const payload = {
          query: String(input.query ?? ""),
          ...(typeof input.site === "string" && input.site.trim()
            ? { site: input.site.trim() }
            : searchSettings.defaultSite
              ? { site: searchSettings.defaultSite }
              : {}),
          ...(typeof input.filetype === "string" && input.filetype.trim()
            ? { filetype: input.filetype.trim() }
            : searchSettings.defaultFiletype
              ? { filetype: searchSettings.defaultFiletype }
              : {}),
          fetch_full:
            typeof input.fetch_full === "boolean"
              ? input.fetch_full
              : searchSettings.defaultFetchFull,
          sort:
            input.sort === "date" || input.sort === "relevance"
              ? input.sort
              : searchSettings.defaultSort,
          ...(typeof input.time_range === "string" && input.time_range.trim()
            ? { time_range: input.time_range }
            : searchSettings.defaultTimeRange
              ? { time_range: searchSettings.defaultTimeRange }
              : {}),
        };
        return {
          output: await runSearchRequest(payload),
        };
      }
      case "browser_status": {
        return {
          output: toPrettyJson(await context.browser.getStatus()),
        };
      }
      case "browser_open": {
        return {
          output: toPrettyJson(
            await context.browser.open(String(input.url ?? "")),
          ),
        };
      }
      case "browser_snapshot": {
        return {
          output: toPrettyJson(
            await context.browser.snapshot(
              typeof input.url === "string" ? input.url : undefined,
            ),
          ),
        };
      }
      case "browser_screenshot": {
        return {
          output: await context.browser.screenshot(
            typeof input.path === "string" ? input.path : undefined,
          ),
        };
      }
      case "request_user_input": {
        const parsed = UserInputRequestSchema.parse(input);
        const handler = context.interactive?.requestUserInput;
        if (!handler) {
          throw new Error(
            "Interactive user input is unavailable in this session.",
          );
        }

        const previousPhase = context.taskState?.phase;
        if (context.taskState) {
          context.taskState.phase = "awaiting-input";
        }

        let answers: UserInputResult;
        try {
          answers = await handler(parsed);
        } finally {
          if (
            context.taskState &&
            context.interactionMode === "task" &&
            previousPhase
          ) {
            context.taskState.phase = previousPhase;
          }
        }

        return {
          output: serializeStructuredResult({
            status: answers.status,
            answers: answers.answers,
            answers_by_id: buildUserInputAnswersById(answers),
          }),
          control: {
            restartLoop: true,
          },
        };
      }
      case "grant_permissions": {
        const state = requirePermissionState(context.permissions);
        const rawScope = String(input.scope ?? "").trim().toLowerCase();
        const tool = String(input.tool ?? "").trim();
        const shellPrefix = String(input.shellPrefix ?? "").trim().toLowerCase();

        switch (rawScope) {
          case "once": {
            if (shellPrefix) {
              state.allowedOnceShellPrefixes.add(shellPrefix);
              return {
                output: serializeStructuredResult({
                  status: "updated",
                  scope: "once",
                  tool: "shell",
                  shell_prefix: shellPrefix,
                  message: `Allowed shell prefix "${shellPrefix}" for one call.`,
                }),
              };
            }

            if (!tool || !isApprovalRequiredTool(tool)) {
              throw new Error(
                `scope "once" requires a risky tool name (${listApprovalRequiredTools().join(", ")}).`,
              );
            }

            state.allowedOnceTools.add(tool);
            return {
              output: serializeStructuredResult({
                status: "updated",
                scope: "once",
                tool,
                message: `Allowed ${tool} for one call.`,
              }),
            };
          }
          case "tool": {
            if (!tool || !isApprovalRequiredTool(tool)) {
              throw new Error(
                `scope "tool" requires a risky tool name (${listApprovalRequiredTools().join(", ")}).`,
              );
            }

            state.allowedTools.add(tool);
            return {
              output: serializeStructuredResult({
                status: "updated",
                scope: "tool",
                tool,
                message: `Allowed ${tool} for this session.`,
              }),
            };
          }
          case "shell-prefix": {
            if (!shellPrefix) {
              throw new Error(
                'scope "shell-prefix" requires shellPrefix, such as "mkdir".',
              );
            }

            state.allowedShellPrefixes.add(shellPrefix);
            return {
              output: serializeStructuredResult({
                status: "updated",
                scope: "shell-prefix",
                tool: "shell",
                shell_prefix: shellPrefix,
                message: `Allowed shell prefix "${shellPrefix}" for this session.`,
              }),
            };
          }
          case "next-turn": {
            state.allowAllNextTurn = true;
            return {
              output: serializeStructuredResult({
                status: "updated",
                scope: "next-turn",
                message: "Allowed all risky tools for the current turn.",
              }),
            };
          }
          case "session": {
            state.allowAllSession = true;
            state.allowAllNextTurn = false;
            return {
              output: serializeStructuredResult({
                status: "updated",
                scope: "session",
                message: "Allowed all risky tools for this session.",
              }),
            };
          }
          case "reset": {
            clearToolPermissionState(state);
            return {
              output: serializeStructuredResult({
                status: "updated",
                scope: "reset",
                message: "Cleared all permission grants for this session.",
              }),
            };
          }
          default:
            throw new Error(
              'scope must be one of "once", "tool", "shell-prefix", "next-turn", "session", or "reset".',
            );
        }
      }
      case "task_submit_plan": {
        if (context.interactionMode !== "task" || !context.taskState) {
          throw new Error("task_submit_plan is only available in Task mode.");
        }

        const handler = context.interactive?.submitTaskPlan;
        if (!handler) {
          throw new Error("Task plan approval is unavailable in this session.");
        }

        const plan = PendingTaskPlanSchema.parse(input);
        const previousPhase = context.taskState.phase;
        context.taskState.pendingPlan = plan;
        context.taskState.phase = "awaiting-approval";

        let decision: TaskPlanDecision;
        try {
          decision = await handler(plan);
        } catch (error) {
          context.taskState.pendingPlan = undefined;
          context.taskState.phase = previousPhase;
          throw error;
        }

        context.taskState.pendingPlan = undefined;

        if (decision.status === "approved") {
          context.taskState.phase = "executing";
          return {
            output: serializeStructuredResult({
              status: "approved",
              message: "The user approved the task plan. Begin execution.",
              plan,
            }),
            control: {
              restartLoop: true,
              resetToolTurns: true,
            },
          };
        }

        if (decision.status === "revise") {
          context.taskState.phase = "planning";
          return {
            output: serializeStructuredResult({
              status: "revise",
              message: "The user requested changes to the plan before execution.",
              ...(decision.feedback?.trim()
                ? { feedback: decision.feedback.trim() }
                : {}),
            }),
            control: {
              restartLoop: true,
            },
          };
        }

        context.taskState.phase = "planning";
        return {
          output: serializeStructuredResult({
            status: "cancelled",
            message: "The user cancelled the task before execution.",
          }),
          control: {
            endTurnText: "Task cancelled. No changes were made.",
          },
        };
      }
      case "agent_spawn": {
        const record = context.agents.spawnAgent({
          task: String(input.task ?? ""),
          mode:
            input.mode === "worktree" || input.mode === "tmux"
              ? input.mode
              : "background",
          cwd:
            typeof input.cwd === "string" && input.cwd.trim()
              ? resolveToolPath(context.cwd, input.cwd)
              : context.cwd,
          profileName: context.profile.meta.name,
          model: context.model,
          interactionMode: context.interactionMode,
          taskPhase: context.taskState?.phase,
          ...(typeof input.name === "string" ? { name: input.name } : {}),
        });
        return { output: toPrettyJson(record) };
      }
      case "agent_send": {
        const record = context.agents.enqueueMessage(
          String(input.agentId ?? ""),
          String(input.message ?? ""),
        );
        if (!record) {
          throw new Error("Agent not found.");
        }
        return { output: toPrettyJson(record) };
      }
      case "agent_wait": {
        const record = await context.agents.waitForAgent(
          String(input.agentId ?? ""),
          typeof input.timeoutMs === "number" ? input.timeoutMs : 60_000,
        );
        if (!record) {
          throw new Error("Agent not found.");
        }
        return { output: toPrettyJson(record) };
      }
      case "agent_abort": {
        const record = context.agents.abortAgent(String(input.agentId ?? ""));
        if (!record) {
          throw new Error("Agent not found.");
        }
        return { output: toPrettyJson(record) };
      }
      default:
        throw new Error(`Unknown tool: ${call.name}`);
    }
  } catch (error) {
    return {
      output: error instanceof Error ? error.message : String(error),
      isError: true,
    };
  }
}
