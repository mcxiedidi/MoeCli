import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { TaskPhase } from "../session/taskTypes.js";
import {
  summarizeToolCall,
  summarizeToolResult,
  TurnRenderer,
} from "./turnRenderer.js";

function stripAnsi(text: string): string {
  return text.replace(
    // eslint-disable-next-line no-control-regex
    /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g,
    "",
  );
}

describe("turnRenderer helpers", () => {
  it("summarizes web search tool calls with the query", () => {
    expect(
      summarizeToolCall({
        id: "tool-1",
        name: "web_search",
        argumentsText: JSON.stringify({
          query: "current codex pricing",
          sort: "date",
        }),
      }),
    ).toBe('query="current codex pricing"');
  });

  it("summarizes successful web search results with count and query", () => {
    expect(
      summarizeToolResult(
        {
          id: "tool-1",
          name: "web_search",
          argumentsText: "{}",
        },
        JSON.stringify({
          query: "codex pricing",
          total_results: 10,
        }),
      ),
    ).toBe('10 results for "codex pricing"');
  });

  it("summarizes permission-required tool errors cleanly", () => {
    expect(
      summarizeToolResult(
        {
          id: "tool-perm",
          name: "shell",
          argumentsText: "{}",
        },
        JSON.stringify({
          status: "permission_required",
          tool: "shell",
        }),
        true,
      ),
    ).toBe("permission required");
  });

  it("falls back to regex extraction for truncated search payloads", () => {
    expect(
      summarizeToolResult(
        {
          id: "tool-1",
          name: "web_search",
          argumentsText: "{}",
        },
        '{"query":"codex pricing current","total_results":15,"results":[{"title":"a"}',
      ),
    ).toBe('15 results for "codex pricing current"');
  });

  it("summarizes structured user-input prompts and results", () => {
    expect(
      summarizeToolCall({
        id: "tool-2",
        name: "request_user_input",
        argumentsText: JSON.stringify({
          questions: [
            {
              header: "Scope",
              id: "scope",
              question: "Should I touch the UI too?",
              options: [
                {
                  label: "Yes",
                  description: "Include UI polish",
                },
              ],
            },
          ],
        }),
      }),
    ).toBe('question="Should I touch the UI too?"');

    expect(
      summarizeToolResult(
        {
          id: "tool-2",
          name: "request_user_input",
          argumentsText: "{}",
        },
        JSON.stringify({
          status: "answered",
          answers: [
            {
              id: "scope",
              question: "Should I touch the UI too?",
            },
          ],
        }),
      ),
    ).toBe("1 answer captured");
  });

  it("summarizes task plan approval results", () => {
    expect(
      summarizeToolCall({
        id: "tool-3",
        name: "task_submit_plan",
        argumentsText: JSON.stringify({
          title: "Implement task workflow",
        }),
      }),
    ).toBe('plan="Implement task workflow"');

    expect(
      summarizeToolResult(
        {
          id: "tool-3",
          name: "task_submit_plan",
          argumentsText: "{}",
        },
        JSON.stringify({
          status: "approved",
        }),
      ),
    ).toBe("plan approved");
  });

  it("summarizes permission grant tool calls and results", () => {
    expect(
      summarizeToolCall({
        id: "tool-4",
        name: "grant_permissions",
        argumentsText: JSON.stringify({
          scope: "shell-prefix",
          shellPrefix: "mkdir",
        }),
      }),
    ).toBe("shell-prefix mkdir");

    expect(
      summarizeToolResult(
        {
          id: "tool-4",
          name: "grant_permissions",
          argumentsText: "{}",
        },
        JSON.stringify({
          status: "updated",
          scope: "shell-prefix",
        }),
      ),
    ).toBe("permissions updated");
  });

  it("renders the latest task phase for each streamed segment", () => {
    const output = new PassThrough();
    let rendered = "";
    output.on("data", (chunk) => {
      rendered += chunk.toString();
    });
    (
      output as PassThrough & {
        isTTY?: boolean;
        columns?: number;
      }
    ).isTTY = false;
    (
      output as PassThrough & {
        isTTY?: boolean;
        columns?: number;
      }
    ).columns = 96;

    let phase: TaskPhase = "planning";
    const renderer = new TurnRenderer({
      profileName: "RightCode",
      providerKind: "openai",
      model: "gpt-5.4",
      interactionMode: "task",
      getTaskPhase: () => phase,
      output: output as unknown as NodeJS.WriteStream,
    });

    renderer.handle({ type: "message-start" });
    renderer.handle({ type: "text-delta", delta: "Planning first" });
    renderer.handle({ type: "message-stop" });

    phase = "executing";
    renderer.handle({ type: "message-start" });
    renderer.handle({ type: "text-delta", delta: "Now executing" });
    renderer.handle({ type: "message-stop" });
    renderer.close();

    const plain = stripAnsi(rendered);
    expect(plain).toContain("/ task:planning");
    expect(plain).toContain("/ task:executing");
  });

  it("renders status events outside the streamed message bubble", () => {
    const output = new PassThrough();
    let rendered = "";
    output.on("data", (chunk) => {
      rendered += chunk.toString();
    });
    (
      output as PassThrough & {
        isTTY?: boolean;
        columns?: number;
      }
    ).isTTY = false;

    const renderer = new TurnRenderer({
      profileName: "RightCode",
      providerKind: "openai",
      model: "gpt-5.4",
      interactionMode: "chat-edit",
      output: output as unknown as NodeJS.WriteStream,
    });

    renderer.handle({
      type: "status",
      message: "context compressed",
      tone: "warning",
    });
    renderer.close();

    expect(stripAnsi(rendered)).toContain("[status] context compressed");
  });
});
