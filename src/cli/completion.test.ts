import { describe, expect, it } from "vitest";
import {
  buildModelCompletions,
  buildModeCompletions,
  buildSlashCommandCompletions,
  findSlashCommandSuggestions,
} from "./completion.js";

describe("CLI completion helpers", () => {
  it("suggests slash commands from partial input", () => {
    const suggestions = findSlashCommandSuggestions("/mo");

    expect(suggestions[0]?.command).toBe("/model");
  });

  it("builds slash command completions for tab completion", () => {
    expect(buildSlashCommandCompletions("/st")).toEqual([["/status"], "/st"]);
  });

  it("builds model completions for /model <id>", () => {
    expect(
      buildModelCompletions("/model gpt-5", ["gpt-5", "gpt-5-mini", "gpt-4o"]),
    ).toEqual([["gpt-5", "gpt-5-mini"], "gpt-5"]);
  });

  it("builds mode completions for /mode <name>", () => {
    expect(buildModeCompletions("/mode ta")).toEqual([["task"], "ta"]);
  });
});
