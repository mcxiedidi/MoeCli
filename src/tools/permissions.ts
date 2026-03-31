import type { UnifiedToolCall } from "../providers/types.js";

const APPROVAL_REQUIRED_TOOL_NAMES = [
  "write_file",
  "shell",
  "browser_open",
  "browser_screenshot",
  "agent_spawn",
  "agent_send",
  "agent_abort",
] as const;

export type ApprovalRequiredToolName =
  (typeof APPROVAL_REQUIRED_TOOL_NAMES)[number];

export interface ToolPermissionState {
  allowAllSession: boolean;
  allowAllNextTurn: boolean;
  allowedTools: Set<string>;
  allowedShellPrefixes: Set<string>;
  allowedOnceTools: Set<string>;
  allowedOnceShellPrefixes: Set<string>;
}

export interface ToolApprovalRequest {
  call: UnifiedToolCall;
  toolName: string;
  summary: string;
  commandText?: string | undefined;
  shellCommandPrefix?: string | undefined;
}

function truncate(text: string, limit = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }

  if (limit <= 3) {
    return ".".repeat(limit);
  }

  return `${normalized.slice(0, limit - 3)}...`;
}

export function createToolPermissionState(): ToolPermissionState {
  return {
    allowAllSession: false,
    allowAllNextTurn: false,
    allowedTools: new Set<string>(),
    allowedShellPrefixes: new Set<string>(),
    allowedOnceTools: new Set<string>(),
    allowedOnceShellPrefixes: new Set<string>(),
  };
}

export function createAutonomousToolPermissionState(): ToolPermissionState {
  return {
    allowAllSession: true,
    allowAllNextTurn: false,
    allowedTools: new Set<string>(),
    allowedShellPrefixes: new Set<string>(),
    allowedOnceTools: new Set<string>(),
    allowedOnceShellPrefixes: new Set<string>(),
  };
}

export function clearToolPermissionState(state: ToolPermissionState): void {
  state.allowAllSession = false;
  state.allowAllNextTurn = false;
  state.allowedTools.clear();
  state.allowedShellPrefixes.clear();
  state.allowedOnceTools.clear();
  state.allowedOnceShellPrefixes.clear();
}

export function listApprovalRequiredTools(): ApprovalRequiredToolName[] {
  return [...APPROVAL_REQUIRED_TOOL_NAMES];
}

export function isApprovalRequiredTool(
  name: string,
): name is ApprovalRequiredToolName {
  return APPROVAL_REQUIRED_TOOL_NAMES.includes(name as ApprovalRequiredToolName);
}

export function getShellCommandPrefix(
  command: string,
): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) {
    return undefined;
  }

  const match = trimmed.match(/^("(?:[^"]+)"|'(?:[^']+)'|\S+)/);
  const token = match?.[1]?.trim();
  if (!token) {
    return undefined;
  }

  return token.replace(/^['"]|['"]$/g, "").toLowerCase();
}

export function buildToolApprovalRequest(
  call: UnifiedToolCall,
  input: Record<string, unknown>,
): ToolApprovalRequest {
  switch (call.name) {
    case "shell": {
      const commandText = String(input.command ?? "").trim();
      return {
        call,
        toolName: call.name,
        summary: commandText
          ? `Shell command: ${truncate(commandText)}`
          : "Shell command execution",
        ...(commandText ? { commandText } : {}),
        ...(commandText
          ? { shellCommandPrefix: getShellCommandPrefix(commandText) }
          : {}),
      };
    }
    case "write_file": {
      const path = String(input.path ?? "").trim();
      return {
        call,
        toolName: call.name,
        summary: path ? `Write file: ${path}` : "Write file",
      };
    }
    case "browser_open": {
      const url = String(input.url ?? "").trim();
      return {
        call,
        toolName: call.name,
        summary: url ? `Open browser: ${truncate(url, 96)}` : "Open browser URL",
      };
    }
    case "browser_screenshot": {
      const path = String(input.path ?? "").trim();
      return {
        call,
        toolName: call.name,
        summary: path
          ? `Browser screenshot to: ${path}`
          : "Take browser screenshot",
      };
    }
    case "agent_spawn": {
      const task = String(input.task ?? "").trim();
      return {
        call,
        toolName: call.name,
        summary: task
          ? `Spawn sub-agent: ${truncate(task, 96)}`
          : "Spawn sub-agent",
      };
    }
    case "agent_send": {
      const agentId = String(input.agentId ?? "").trim();
      const message = String(input.message ?? "").trim();
      return {
        call,
        toolName: call.name,
        summary:
          agentId || message
            ? `Send to agent ${agentId || "(unknown)"}: ${truncate(message, 72)}`
            : "Send message to sub-agent",
      };
    }
    case "agent_abort": {
      const agentId = String(input.agentId ?? "").trim();
      return {
        call,
        toolName: call.name,
        summary: agentId ? `Abort agent: ${agentId}` : "Abort sub-agent",
      };
    }
    default:
      return {
        call,
        toolName: call.name,
        summary: `Execute ${call.name}`,
      };
  }
}

export function consumeToolCallApproval(
  state: ToolPermissionState | undefined,
  request: ToolApprovalRequest,
): boolean {
  if (!state) {
    return false;
  }

  if (state.allowAllSession || state.allowAllNextTurn) {
    return true;
  }

  if (state.allowedTools.has(request.toolName)) {
    return true;
  }

  if (
    request.toolName === "shell" &&
    request.shellCommandPrefix &&
    state.allowedShellPrefixes.has(request.shellCommandPrefix)
  ) {
    return true;
  }

  if (state.allowedOnceTools.has(request.toolName)) {
    state.allowedOnceTools.delete(request.toolName);
    return true;
  }

  if (
    request.toolName === "shell" &&
    request.shellCommandPrefix &&
    state.allowedOnceShellPrefixes.has(request.shellCommandPrefix)
  ) {
    state.allowedOnceShellPrefixes.delete(request.shellCommandPrefix);
    return true;
  }

  return false;
}
