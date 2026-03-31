import { describe, expect, it } from "vitest";
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
} from "../providers/helpers.js";
import {
  chunkMessagesByTokenBudget,
  chooseMessagesToArchive,
  type ContextBudget,
} from "./contextManagement.js";

const budget: ContextBudget = {
  modelContextWindow: 128_000,
  reservedSummaryOutputTokens: 6_000,
  effectiveContextWindow: 122_000,
  autoCompactThreshold: 110_000,
  recentTailTokenBudget: 1,
  isModelContextWindowKnown: true,
};

describe("contextManagement", () => {
  it("keeps assistant tool calls paired with tool results when chunking", () => {
    const assistant = createAssistantMessage("", "", [
      {
        id: "tool-1",
        name: "read_file",
        argumentsText: "{\"path\":\"src/index.ts\"}",
      },
    ]);
    const toolResult = createToolResultMessage(
      {
        id: "tool-1",
        name: "read_file",
        argumentsText: "{\"path\":\"src/index.ts\"}",
      },
      "file body",
    );

    const chunks = chunkMessagesByTokenBudget(
      [
        createUserMessage("read the entrypoint"),
        assistant,
        toolResult,
        createUserMessage("continue"),
      ],
      1,
    );

    expect(chunks[1]).toHaveLength(2);
    expect(chunks[1]?.[0]?.role).toBe("assistant");
    expect(chunks[1]?.[1]?.role).toBe("tool");
  });

  it("preserves the latest user-planning context in task mode", () => {
    const snapshot = chooseMessagesToArchive(
      [
        createUserMessage("goal"),
        createAssistantMessage("noted", "", []),
        createUserMessage("scan the repo first"),
        createAssistantMessage("reading files", "", []),
        createUserMessage("wait for approval before editing"),
        createAssistantMessage("planning next", "", []),
      ],
      budget,
      "task",
      { phase: "awaiting-approval" },
    );

    expect(snapshot).toBeDefined();
    expect(
      snapshot?.keptRecentMessages.some(
        (message) =>
          message.role === "user" &&
          message.parts.some(
            (part) =>
              part.type === "text" &&
              part.text.includes("wait for approval before editing"),
          ),
      ),
    ).toBe(true);
  });
});
