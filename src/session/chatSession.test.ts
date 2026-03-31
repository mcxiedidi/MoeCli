import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserSession } from "../browser/session.js";
import type { AgentManager } from "../agents/manager.js";
import type { ProviderAdapter, ResolvedProviderProfile } from "../providers/types.js";
import {
  createAssistantMessage,
  createUserMessage,
} from "../providers/helpers.js";

const mocks = vi.hoisted(() => ({
  streamResponse: vi.fn<ProviderAdapter["streamResponse"]>(),
  executeToolCall: vi.fn(),
  getAvailableTools: vi.fn((tools: unknown) => tools),
}));

vi.mock("../providers/index.js", () => ({
  getProviderAdapter: () => ({
    streamResponse: mocks.streamResponse,
  }),
}));

vi.mock("../tools/registry.js", () => ({
  executeToolCall: mocks.executeToolCall,
  getAvailableTools: mocks.getAvailableTools,
}));

import { ChatSession } from "./chatSession.js";

function createToolResult(name: string, id: string) {
  return {
    assistantMessage: {
      role: "assistant" as const,
      parts: [
        {
          type: "tool-call" as const,
          call: {
            id,
            name,
            argumentsText: "{}",
          },
        },
      ],
      timestamp: "2026-04-01T00:00:00.000Z",
    },
    toolCalls: [
      {
        id,
        name,
        argumentsText: "{}",
      },
    ],
  };
}

function createTextResult(text: string) {
  return {
    assistantMessage: {
      role: "assistant" as const,
      parts: [
        {
          type: "text" as const,
          text,
        },
      ],
      timestamp: "2026-04-01T00:00:00.000Z",
    },
    toolCalls: [],
  };
}

function createProfile(): ResolvedProviderProfile {
  return {
    meta: {
      id: "profile-1",
      name: "Test",
      kind: "openai-compatible",
      enabled: true,
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
    },
    secrets: {
      profileId: "profile-1",
      apiKey: "test-key",
    },
  };
}

function seedConversation(
  session: ChatSession,
  count: number,
  textFactory: (index: number) => string,
): void {
  for (let index = 0; index < count; index += 1) {
    session.messages.push(createUserMessage(`user ${index}: ${textFactory(index)}`));
    session.messages.push(
      createAssistantMessage(`assistant ${index}: ${textFactory(index)}`, "", []),
    );
  }
}

describe("ChatSession", () => {
  beforeEach(() => {
    mocks.streamResponse.mockReset();
    mocks.executeToolCall.mockReset();
    mocks.getAvailableTools.mockReset();
    mocks.getAvailableTools.mockImplementation((tools: unknown) => tools);
  });

  it("rolls back the pending user turn after provider failures", async () => {
    mocks.streamResponse.mockImplementation(
      async function* () {
        throw new Error("provider failed");
      },
    );

    const profile = createProfile();
    const session = new ChatSession({
      profile,
      model: "gpt-5",
      cwd: process.cwd(),
      toolContext: {
        cwd: process.cwd(),
        profile,
        model: "gpt-5",
        interactionMode: "chat-edit",
        browser: {} as BrowserSession,
        agents: {} as AgentManager,
      },
    });

    await expect(session.send("hi")).rejects.toThrow("provider failed");
    expect(session.messages).toHaveLength(0);
  });

  it("ends the turn with synthetic assistant text when a tool cancels execution", async () => {
    mocks.streamResponse.mockImplementationOnce(
      async function* () {
        return {
          assistantMessage: {
            role: "assistant",
            parts: [
              {
                type: "tool-call",
                call: {
                  id: "tool-1",
                  name: "task_submit_plan",
                  argumentsText: "{}",
                },
              },
            ],
            timestamp: "2026-04-01T00:00:00.000Z",
          },
          toolCalls: [
            {
              id: "tool-1",
              name: "task_submit_plan",
              argumentsText: "{}",
            },
          ],
        };
      },
    );
    mocks.executeToolCall.mockResolvedValueOnce({
      output: '{"status":"cancelled"}',
      control: {
        endTurnText: "Task cancelled. No changes were made.",
      },
    });

    const profile = createProfile();
    const session = new ChatSession({
      profile,
      model: "gpt-5",
      cwd: process.cwd(),
      interactionMode: "task",
      toolContext: {
        cwd: process.cwd(),
        profile,
        model: "gpt-5",
        interactionMode: "task",
        browser: {} as BrowserSession,
        agents: {} as AgentManager,
      },
    });

    const result = await session.send("implement this");

    expect(result.finishReason).toBe("cancelled");
    expect(result.assistantMessage.parts[0]).toMatchObject({
      type: "text",
      text: "Task cancelled. No changes were made.",
    });
  });

  it("resets the tool counter after plan approval within the same turn", async () => {
    const results = [
      createToolResult("task_submit_plan", "tool-1"),
      ...Array.from({ length: 24 }, (_, index) =>
        createToolResult("read_file", `tool-${index + 2}`),
      ),
      createTextResult("execution finished"),
    ];

    mocks.streamResponse.mockImplementation(async function* () {
      const next = results.shift();
      if (!next) {
        throw new Error("unexpected provider call");
      }
      return next;
    });
    mocks.executeToolCall.mockImplementation(
      async (
        toolCall: { name: string },
        context: { taskState?: { phase: string } },
      ) => {
        if (toolCall.name === "task_submit_plan" && context.taskState) {
          context.taskState.phase = "executing";
          return {
            output: '{"status":"approved"}',
            control: {
              restartLoop: true,
              resetToolTurns: true,
            },
          };
        }

        return {
          output: "{}",
          control: {
            restartLoop: true,
          },
        };
      },
    );

    const profile = createProfile();
    const session = new ChatSession({
      profile,
      model: "gpt-5",
      cwd: process.cwd(),
      interactionMode: "task",
      toolContext: {
        cwd: process.cwd(),
        profile,
        model: "gpt-5",
        interactionMode: "task",
        browser: {} as BrowserSession,
        agents: {} as AgentManager,
      },
    });

    const result = await session.send("implement this");

    expect(result.assistantMessage.parts[0]).toMatchObject({
      type: "text",
      text: "execution finished",
    });
    expect(session.getTaskState()?.phase).toBe("executing");
    expect(mocks.streamResponse).toHaveBeenCalledTimes(26);
  });

  it("preserves executing sessions for agent-style task runs", async () => {
    const results = [
      ...Array.from({ length: 9 }, (_, index) =>
        createToolResult("read_file", `tool-${index + 1}`),
      ),
      createTextResult("done"),
    ];

    mocks.streamResponse.mockImplementation(async function* () {
      const next = results.shift();
      if (!next) {
        throw new Error("unexpected provider call");
      }
      return next;
    });
    mocks.executeToolCall.mockResolvedValue({
      output: "{}",
      control: {
        restartLoop: true,
      },
    });

    const profile = createProfile();
    const session = new ChatSession({
      profile,
      model: "gpt-5",
      cwd: process.cwd(),
      interactionMode: "task",
      taskState: {
        phase: "executing",
      },
      resetTaskPhaseOnUserTurn: false,
      toolContext: {
        cwd: process.cwd(),
        profile,
        model: "gpt-5",
        interactionMode: "task",
        browser: {} as BrowserSession,
        agents: {} as AgentManager,
      },
    });

    await expect(session.send("continue execution")).rejects.toThrow(
      "Tool loop exceeded the limit of 8 turns after plan approval.",
    );
  });

  it("auto-compacts long conversations while preserving the full transcript", async () => {
    const requests: Array<{
      systemPrompt?: string | undefined;
      messagesLength: number;
    }> = [];

    mocks.streamResponse.mockImplementation(
      async function* (
        request: Parameters<ProviderAdapter["streamResponse"]>[0],
      ) {
        requests.push({
          systemPrompt: request.systemPrompt,
          messagesLength: request.messages.length,
        });
        return createTextResult("done after compaction");
      },
    );

    const profile = createProfile();
    const session = new ChatSession({
      profile,
      model: "gpt-5",
      cwd: process.cwd(),
      toolContext: {
        cwd: process.cwd(),
        profile,
        model: "gpt-5",
        interactionMode: "chat-edit",
        browser: {} as BrowserSession,
        agents: {} as AgentManager,
      },
    });

    seedConversation(session, 6, (index) => `${String(index).repeat(40_000)}`);

    const result = await session.send("continue from there");

    expect(result.assistantMessage.parts[0]).toMatchObject({
      type: "text",
      text: "done after compaction",
    });

    const mainRequests = requests.filter(
      (request) =>
        !request.systemPrompt?.includes("durable coding-session memory") &&
        !request.systemPrompt?.includes(
          "compacting a long coding conversation",
        ),
    );
    expect(mainRequests).toHaveLength(1);

    const contextState = session.getContextManagementState();
    expect(contextState.stats.compressionCount).toBeGreaterThan(0);
    expect(contextState.fullMessageCount).toBeGreaterThan(
      contextState.activeMessageCount,
    );
    expect(mainRequests[0]?.messagesLength).toBeLessThan(
      contextState.fullMessageCount,
    );
    expect(session.messages).toHaveLength(14);
  });

  it("compacts and retries after overflow while resetting response chaining", async () => {
    const mainProviderStates = [] as Array<Record<string, unknown> | undefined>;

    mocks.streamResponse.mockImplementation(
      async function* (
        request: Parameters<ProviderAdapter["streamResponse"]>[0],
      ) {
        if (request.systemPrompt?.includes("durable coding-session memory")) {
          return createTextResult("## Current State\n- memory updated");
        }
        if (
          request.systemPrompt?.includes(
            "compacting a long coding conversation",
          )
        ) {
          return createTextResult("## Current State\n- compacted");
        }

        mainProviderStates.push(
          request.providerState as Record<string, unknown> | undefined,
        );
        if (mainProviderStates.length === 1) {
          const error = Object.assign(new Error("prompt too long"), {
            status: 413,
          });
          throw error;
        }

        return createTextResult("recovered");
      },
    );

    const profile = createProfile();
    const session = new ChatSession({
      profile,
      model: "gpt-5",
      cwd: process.cwd(),
      toolContext: {
        cwd: process.cwd(),
        profile,
        model: "gpt-5",
        interactionMode: "chat-edit",
        browser: {} as BrowserSession,
        agents: {} as AgentManager,
      },
    });

    seedConversation(
      session,
      10,
      (index) => `${String(index).repeat(4_000)} middle context`,
    );
    (
      session as unknown as {
        providerState?: Record<string, unknown>;
      }
    ).providerState = {
      previousResponseId: "resp_123",
      sentMessageCount: 20,
      supportsPreviousResponseId: true,
      supportsTools: true,
    };

    const result = await session.send("retry this turn");

    expect(result.assistantMessage.parts[0]).toMatchObject({
      type: "text",
      text: "recovered",
    });
    expect(mainProviderStates).toHaveLength(2);
    expect(mainProviderStates[0]).toMatchObject({
      previousResponseId: "resp_123",
      sentMessageCount: 20,
    });
    expect(mainProviderStates[1]).not.toHaveProperty("previousResponseId");
    expect(mainProviderStates[1]).not.toHaveProperty("sentMessageCount");
    expect(mainProviderStates[1]).toMatchObject({
      supportsPreviousResponseId: true,
      supportsTools: true,
    });
    expect(session.getContextManagementState().stats.compressionCount).toBe(1);
  });
});
