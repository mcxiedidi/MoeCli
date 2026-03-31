import type {
  ProviderKind,
  UnifiedStreamEvent,
  UnifiedToolCall,
  UnifiedUsage,
} from "../providers/types.js";
import type { InteractionMode } from "../cli/interactionMode.js";
import type { TaskPhase } from "../session/taskTypes.js";
import { safeJsonParse } from "./json.js";
import { theme } from "./theme.js";

const SPINNER_FRAMES = ["-", "\\", "|", "/"];
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

interface TurnRendererOptions {
  profileName: string;
  providerKind: ProviderKind;
  model: string;
  interactionMode: InteractionMode;
  taskPhase?: TaskPhase | undefined;
  getTaskPhase?: (() => TaskPhase | undefined) | undefined;
  transport?: string | undefined;
  output?: NodeJS.WriteStream | undefined;
}

type ActivityTone = "primary" | "success" | "warning" | "danger" | "info";

interface TransientState {
  label: string;
  tone: ActivityTone;
  timer: NodeJS.Timeout | undefined;
  frameIndex: number;
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function truncatePlain(text: string, limit: number): string {
  const plain = stripAnsi(text).replace(/\s+/g, " ").trim();
  if (plain.length <= limit) {
    return plain;
  }

  if (limit <= 3) {
    return ".".repeat(limit);
  }

  return `${plain.slice(0, limit - 3)}...`;
}

function colorize(tone: ActivityTone, text: string): string {
  switch (tone) {
    case "success":
      return theme.success(text);
    case "warning":
      return theme.warning(text);
    case "danger":
      return theme.danger(text);
    case "info":
      return theme.info(text);
    default:
      return theme.primary(text);
  }
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return String(value);
}

function formatTaskPhaseLabel(phase: TaskPhase): string {
  switch (phase) {
    case "awaiting-input":
      return "input";
    case "awaiting-approval":
      return "approval";
    default:
      return phase;
  }
}

export function summarizeToolCall(call: UnifiedToolCall): string | undefined {
  const parsed = safeJsonParse<Record<string, unknown>>(call.argumentsText);
  if (parsed) {
    switch (call.name) {
      case "web_search":
        if (typeof parsed.query === "string" && parsed.query.trim()) {
          return `query="${truncatePlain(parsed.query, 56)}"`;
        }
        break;
      case "shell":
        if (typeof parsed.command === "string" && parsed.command.trim()) {
          return truncatePlain(parsed.command, 64);
        }
        break;
      case "read_file":
      case "write_file":
      case "list_files":
      case "browser_screenshot":
        if (typeof parsed.path === "string" && parsed.path.trim()) {
          return truncatePlain(parsed.path, 64);
        }
        break;
      case "browser_open":
      case "browser_snapshot":
        if (typeof parsed.url === "string" && parsed.url.trim()) {
          return truncatePlain(parsed.url, 64);
        }
        break;
      case "agent_spawn":
        if (typeof parsed.task === "string" && parsed.task.trim()) {
          return truncatePlain(parsed.task, 64);
        }
        break;
      case "agent_send":
        if (typeof parsed.message === "string" && parsed.message.trim()) {
          return truncatePlain(parsed.message, 64);
        }
        break;
      case "request_user_input": {
        const questions = Array.isArray(parsed.questions) ? parsed.questions : [];
        if (questions.length === 1) {
          const firstQuestion =
            questions[0] &&
            typeof questions[0] === "object" &&
            "question" in questions[0] &&
            typeof questions[0].question === "string"
              ? questions[0].question
              : undefined;
          if (firstQuestion?.trim()) {
            return `question="${truncatePlain(firstQuestion, 52)}"`;
          }
        }
        if (questions.length > 1) {
          return `${questions.length} questions`;
        }
        break;
      }
      case "task_submit_plan":
        if (typeof parsed.title === "string" && parsed.title.trim()) {
          return `plan="${truncatePlain(parsed.title, 52)}"`;
        }
        break;
      case "grant_permissions": {
        const scope =
          typeof parsed.scope === "string" ? truncatePlain(parsed.scope, 24) : undefined;
        const tool =
          typeof parsed.tool === "string" ? truncatePlain(parsed.tool, 24) : undefined;
        const shellPrefix =
          typeof parsed.shellPrefix === "string"
            ? truncatePlain(parsed.shellPrefix, 24)
            : undefined;

        if (scope && shellPrefix) {
          return `${scope} ${shellPrefix}`;
        }
        if (scope && tool) {
          return `${scope} ${tool}`;
        }
        if (scope) {
          return scope;
        }
        break;
      }
      default:
        break;
    }
  }

  if (!call.argumentsText.trim()) {
    return undefined;
  }

  return truncatePlain(call.argumentsText, 64);
}

export function summarizeToolResult(
  call: UnifiedToolCall,
  output: string,
  isError = false,
): string {
  const parsed = safeJsonParse<Record<string, unknown>>(output);
  const status = typeof parsed?.status === "string" ? parsed.status : undefined;

  if (status === "permission_required") {
    return "permission required";
  }

  if (call.name === "web_search") {
    const matchedTotalResults = Number(
      output.match(/"total_results"\s*:\s*(\d+)/)?.[1] ?? NaN,
    );
    const totalResults =
      typeof parsed?.total_results === "number"
        ? parsed.total_results
        : Number.isFinite(matchedTotalResults)
          ? matchedTotalResults
          : undefined;
    const rawQuery =
      typeof parsed?.query === "string"
        ? parsed.query
        : output.match(/"query"\s*:\s*"([^"]+)/)?.[1];
    const query = rawQuery ? truncatePlain(rawQuery, 36) : undefined;
    if (typeof totalResults === "number") {
      return query
        ? `${totalResults} results for "${query}"`
        : `${totalResults} results`;
    }
  }

  if (call.name === "request_user_input") {
    const answers = Array.isArray(parsed?.answers) ? parsed.answers.length : undefined;
    if (status === "cancelled") {
      return "user input cancelled";
    }
    if (typeof answers === "number") {
      return `${answers} answer${answers === 1 ? "" : "s"} captured`;
    }
  }

  if (call.name === "task_submit_plan") {
    if (status === "approved") {
      return "plan approved";
    }
    if (status === "revise") {
      return "plan needs revision";
    }
    if (status === "cancelled") {
      return "task cancelled";
    }
  }

  if (call.name === "grant_permissions") {
    if (status === "updated") {
      return "permissions updated";
    }
  }

  const firstLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);

  if (!firstLine) {
    return isError ? "tool failed" : "completed";
  }

  return truncatePlain(firstLine, isError ? 92 : 76);
}

export class TurnRenderer {
  private readonly profileName: string;
  private readonly providerKind: ProviderKind;
  private readonly model: string;
  private readonly interactionMode: InteractionMode;
  private readonly taskPhase?: TaskPhase | undefined;
  private readonly getTaskPhase?: (() => TaskPhase | undefined) | undefined;
  private readonly transport?: string | undefined;
  private readonly output: NodeJS.WriteStream;
  private readonly animate: boolean;

  private transient: TransientState | undefined;
  private segmentStartedAt = 0;
  private usage?: UnifiedUsage | undefined;
  private visibleToolCalls = 0;
  private bodyOpened = false;
  private lineOpen = false;

  constructor(options: TurnRendererOptions) {
    this.profileName = options.profileName;
    this.providerKind = options.providerKind;
    this.model = options.model;
    this.interactionMode = options.interactionMode;
    this.taskPhase = options.taskPhase;
    this.getTaskPhase = options.getTaskPhase;
    this.transport = options.transport;
    this.output = options.output ?? process.stdout;
    this.animate = Boolean(this.output.isTTY);
  }

  handle(event: UnifiedStreamEvent): void {
    switch (event.type) {
      case "status":
        this.finishTransient();
        this.printActivityRow("status", event.message, event.tone ?? "info");
        break;
      case "message-start":
        this.beginSegment();
        break;
      case "reasoning-delta":
        this.startTransient("Thinking", "info");
        break;
      case "text-delta":
        this.writeTextDelta(event.delta);
        break;
      case "tool-call":
        this.visibleToolCalls += 1;
        this.printBubbleRow(
          `[tool] ${event.call.name}${this.formatToolSuffix(event.call)}`,
          "info",
        );
        break;
      case "tool-call-delta":
        break;
      case "tool-execution-start":
        this.startTransient(
          `Running ${event.call.name}${this.formatToolSuffix(event.call)}`,
          "warning",
        );
        break;
      case "tool-result":
        this.finishTransient();
        this.printActivityRow(
          event.isError ? "tool error" : "tool done",
          `${event.call.name} ${summarizeToolResult(
            event.call,
            event.output,
            Boolean(event.isError),
          )}`,
          event.isError ? "danger" : "success",
        );
        break;
      case "usage":
        this.usage = event.usage;
        break;
      case "message-stop":
        this.finishSegment(event.finishReason);
        break;
      default:
        break;
    }
  }

  close(): void {
    this.finishTransient();
  }

  private beginSegment(): void {
    this.finishTransient();
    this.segmentStartedAt = Date.now();
    this.usage = undefined;
    this.visibleToolCalls = 0;
    this.bodyOpened = false;
    this.lineOpen = false;
  }

  private ensureBubbleHeader(): void {
    if (this.bodyOpened) {
      return;
    }

    this.finishTransient();
    const transportSuffix =
      this.transport && this.transport !== "auto" ? ` / ${this.transport}` : "";
    const taskPhase = this.getTaskPhase?.() ?? this.taskPhase;
    const modeSuffix =
      this.interactionMode === "task"
        ? theme.warning(` / task:${formatTaskPhaseLabel(taskPhase ?? "planning")}`)
        : theme.info(" / chat-edit");
    this.output.write(
      `${theme.primary("+--")} ${theme.primaryBold("MoeCli")} ${theme.provider(
        this.providerKind,
        `${this.profileName}`,
      )}${theme.dim(` / ${this.model}${transportSuffix}`)}${modeSuffix}\n`,
    );
    this.bodyOpened = true;
    this.lineOpen = false;
  }

  private writeTextDelta(delta: string): void {
    if (!delta) {
      return;
    }

    this.ensureBubbleHeader();
    const normalized = delta.replace(/\r\n?/g, "\n");
    const parts = normalized.split("\n");

    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index] ?? "";
      if (part) {
        if (!this.lineOpen) {
          this.output.write(`${theme.primary("|")} `);
          this.lineOpen = true;
        }
        this.output.write(part);
      } else if (!this.lineOpen && index < parts.length - 1) {
        this.output.write(`${theme.primary("|")}`);
      }

      if (index < parts.length - 1) {
        this.output.write("\n");
        this.lineOpen = false;
      }
    }
  }

  private printBubbleRow(text: string, tone: ActivityTone): void {
    this.ensureBubbleHeader();
    if (this.lineOpen) {
      this.output.write("\n");
      this.lineOpen = false;
    }
    this.output.write(`${theme.primary("|")} ${colorize(tone, text)}\n`);
  }

  private printActivityRow(
    label: string,
    detail: string,
    tone: ActivityTone,
  ): void {
    if (this.lineOpen) {
      this.output.write("\n");
      this.lineOpen = false;
    }
    this.output.write(
      `${colorize(tone, `[${label}]`)} ${detail}\n`,
    );
  }

  private finishSegment(finishReason?: string | undefined): void {
    this.finishTransient();

    if (!this.bodyOpened) {
      return;
    }

    if (this.lineOpen) {
      this.output.write("\n");
      this.lineOpen = false;
    }

    const elapsedMs = this.segmentStartedAt ? Date.now() - this.segmentStartedAt : 0;
    const summaryParts = [`${(elapsedMs / 1000).toFixed(1)}s`];
    if (this.visibleToolCalls > 0) {
      summaryParts.push(
        `${this.visibleToolCalls} tool${this.visibleToolCalls === 1 ? "" : "s"}`,
      );
    }
    if (typeof this.usage?.inputTokens === "number") {
      summaryParts.push(`in ${formatTokenCount(this.usage.inputTokens)}`);
    }
    if (typeof this.usage?.outputTokens === "number") {
      summaryParts.push(`out ${formatTokenCount(this.usage.outputTokens)}`);
    }
    if (
      finishReason &&
      !["completed", "stop", "end_turn"].includes(finishReason.toLowerCase())
    ) {
      summaryParts.push(finishReason);
    }

    this.output.write(
      `${theme.primary("`--")} ${theme.dim(summaryParts.join(" | "))}\n`,
    );
    this.bodyOpened = false;
  }

  private formatToolSuffix(call: UnifiedToolCall): string {
    const preview = summarizeToolCall(call);
    return preview ? theme.dim(` ${preview}`) : "";
  }

  private startTransient(label: string, tone: ActivityTone): void {
    if (this.transient) {
      this.transient.label = label;
      this.transient.tone = tone;
      return;
    }

    if (!this.animate) {
      this.transient = {
        label,
        tone,
        timer: undefined,
        frameIndex: 0,
      };
      this.printActivityRow("status", label, tone);
      return;
    }

    const state: TransientState = {
      label,
      tone,
      timer: setInterval(() => {
        this.renderTransient();
      }, 90),
      frameIndex: 0,
    };
    this.transient = state;
    this.renderTransient();
  }

  private renderTransient(): void {
    if (!this.transient) {
      return;
    }

    const frame = SPINNER_FRAMES[this.transient.frameIndex % SPINNER_FRAMES.length]!;
    this.transient.frameIndex += 1;
    const line = colorize(
      this.transient.tone,
      `${frame} ${truncatePlain(this.transient.label, this.getTransientWidth())}`,
    );
    this.output.write(`\r\x1b[2K${line}`);
  }

  private finishTransient(): void {
    if (!this.transient) {
      return;
    }

    if (this.transient.timer) {
      clearInterval(this.transient.timer);
    }
    if (this.animate) {
      this.output.write("\r\x1b[2K");
    }
    this.transient = undefined;
  }

  private getTransientWidth(): number {
    const columns = this.output.columns ?? 96;
    return Math.max(24, columns - 4);
  }
}
