import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  getNextInteractionMode,
  parseInteractionMode,
} from "./interactionMode.js";

describe("interaction mode helpers", () => {
  it("cycles between chat-edit and task", () => {
    expect(getNextInteractionMode("chat-edit")).toBe("task");
    expect(getNextInteractionMode("task")).toBe("chat-edit");
  });

  it("accepts task aliases", () => {
    expect(parseInteractionMode("task-mode")).toBe("task");
  });

  it("appends planning guidance to the task system prompt", () => {
    expect(buildSystemPrompt("task", "Base prompt", "planning")).toContain(
      "Do not attempt to execute the task until the user has approved the submitted plan.",
    );
  });
});
