import { describe, expect, it } from "vitest";
import {
  executeToolCall,
  getAvailableTools,
  getBuiltInTools,
  type ToolExecutionContext,
} from "./registry.js";
import { createToolPermissionState } from "./permissions.js";

function createToolContext(
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    cwd: process.cwd(),
    profile: {
      meta: {
        id: "profile-1",
        name: "Test",
        kind: "openai",
        enabled: true,
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:00.000Z",
      },
      secrets: {
        profileId: "profile-1",
        apiKey: "test-key",
      },
    },
    model: "gpt-5.4",
    interactionMode: "chat-edit",
    browser: {
      getStatus: async () => ({ ok: true }),
      open: async () => ({ ok: true }),
      snapshot: async () => ({ ok: true }),
      screenshot: async () => "ok",
    } as unknown as ToolExecutionContext["browser"],
    agents: {
      spawnAgent: () => {
        throw new Error("not expected");
      },
      enqueueMessage: () => null,
      waitForAgent: async () => null,
      abortAgent: () => null,
    } as unknown as ToolExecutionContext["agents"],
    ...overrides,
  };
}

describe("built-in tools", () => {
  it("includes search, browser, agent, and task workflow tools", () => {
    const toolNames = getBuiltInTools().map((tool) => tool.name);

    expect(toolNames).toContain("web_search");
    expect(toolNames).toContain("browser_open");
    expect(toolNames).toContain("agent_spawn");
    expect(toolNames).toContain("shell");
    expect(toolNames).toContain("request_user_input");
    expect(toolNames).toContain("grant_permissions");
    expect(toolNames).toContain("task_submit_plan");
  });

  it("limits task planning to read-only and workflow tools", () => {
    const toolNames = getAvailableTools(
      getBuiltInTools(),
      createToolContext({
        interactionMode: "task",
        taskState: {
          phase: "planning",
        },
      }),
    ).map((tool) => tool.name);

    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("request_user_input");
    expect(toolNames).toContain("grant_permissions");
    expect(toolNames).toContain("task_submit_plan");
    expect(toolNames).not.toContain("write_file");
    expect(toolNames).not.toContain("shell");
    expect(toolNames).not.toContain("agent_spawn");
  });

  it("executes request_user_input with structured answers", async () => {
    const taskState = {
      phase: "executing" as const,
    };
    const result = await executeToolCall(
      {
        id: "tool-1",
        name: "request_user_input",
        argumentsText: JSON.stringify({
          questions: [
            {
              header: "Mode",
              id: "mode",
              question: "Which mode?",
              options: [
                {
                  label: "Task",
                  description: "Plan first",
                },
              ],
            },
          ],
        }),
      },
      createToolContext({
        interactive: {
          requestUserInput: async () => ({
            status: "answered",
            answers: [
              {
                id: "mode",
                question: "Which mode?",
                selectedOption: {
                  label: "Task",
                  description: "Plan first",
                },
              },
            ],
            answersById: {},
          }),
        },
        interactionMode: "task",
        taskState,
      }),
    );

    expect(result.control?.restartLoop).toBe(true);
    expect(result.output).toContain('"status": "answered"');
    expect(result.output).toContain('"answers_by_id"');
    expect(taskState.phase).toBe("executing");
  });

  it("returns a permission-required result before running a shell command", async () => {
    const permissionState = createToolPermissionState();
    const result = await executeToolCall(
      {
        id: "tool-2",
        name: "shell",
        argumentsText: JSON.stringify({
          command: "Get-Date",
        }),
      },
      createToolContext({
        permissions: permissionState,
      }),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain('"status": "permission_required"');
    expect(result.output).toContain('"tool": "shell"');
    expect(result.output).toContain("request_user_input");
  });

  it("grants and consumes one-shot shell permission", async () => {
    const permissionState = createToolPermissionState();

    const grantResult = await executeToolCall(
      {
        id: "tool-grant",
        name: "grant_permissions",
        argumentsText: JSON.stringify({
          scope: "once",
          tool: "shell",
        }),
      },
      createToolContext({
        permissions: permissionState,
      }),
    );

    expect(grantResult.isError).not.toBe(true);
    expect(permissionState.allowedOnceTools.has("shell")).toBe(true);

    const allowedResult = await executeToolCall(
      {
        id: "tool-allowed",
        name: "shell",
        argumentsText: JSON.stringify({
          command: 'node -e "process.stdout.write(\'ok\')"',
        }),
      },
      createToolContext({
        permissions: permissionState,
      }),
    );

    expect(allowedResult.isError).not.toBe(true);
    expect(permissionState.allowedOnceTools.has("shell")).toBe(false);

    const blockedAgain = await executeToolCall(
      {
        id: "tool-blocked",
        name: "shell",
        argumentsText: JSON.stringify({
          command: 'node -e "process.stdout.write(\'ok\')"',
        }),
      },
      createToolContext({
        permissions: permissionState,
      }),
    );

    expect(blockedAgain.isError).toBe(true);
    expect(blockedAgain.output).toContain('"status": "permission_required"');
  });

  it("skips repeated approval after granting a shell prefix", async () => {
    const permissionState = createToolPermissionState();
    permissionState.allowedShellPrefixes.add("node");

    const result = await executeToolCall(
      {
        id: "tool-3",
        name: "shell",
        argumentsText: JSON.stringify({
          command: 'node -e "process.stdout.write(\'ok\')"',
        }),
      },
      createToolContext({
        permissions: permissionState,
      }),
    );

    expect(result.isError).not.toBe(true);
  });
});
