import { describe, expect, it } from "vitest";
import { createAssistantMessage, createUserMessage } from "./helpers.js";
import type { CompletionRequest, ResolvedProviderProfile } from "./types.js";
import {
  isLikelyResponsesUnsupported,
  isPreviousResponseIdUnsupported,
  streamOpenAIResponses,
} from "./openaiCommon.js";

function createProfile(
  overrides?: Partial<ResolvedProviderProfile["meta"]>,
): ResolvedProviderProfile {
  return {
    meta: {
      id: "profile-1",
      name: "RightCode",
      kind: "openai",
      enabled: true,
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      ...(overrides ?? {}),
    },
    secrets: {
      profileId: "profile-1",
      apiKey: "test-key",
    },
  };
}

function createEventStream(events: any[]): AsyncIterable<any> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

async function collectStreamResult<T>(
  stream: AsyncGenerator<any, T>,
): Promise<T> {
  while (true) {
    const step = await stream.next();
    if (step.done) {
      return step.value;
    }
  }
}

describe("isLikelyResponsesUnsupported", () => {
  it("treats blocked 403 compatible errors as fallback candidates", () => {
    expect(
      isLikelyResponsesUnsupported({
        status: 403,
        name: "PermissionDeniedError",
        message: "403 Your request was blocked.",
      }),
    ).toBe(true);
  });

  it("does not over-match unrelated transport errors", () => {
    expect(isLikelyResponsesUnsupported(new Error("socket hang up"))).toBe(false);
  });
});

describe("OpenAI Responses compatibility", () => {
  it("detects explicit previous_response_id rejections", () => {
    expect(
      isPreviousResponseIdUnsupported({
        status: 400,
        message: '{"detail":"Unsupported parameter: previous_response_id"}',
      }),
    ).toBe(true);
  });

  it("retries without previous_response_id for opaque custom-endpoint 400 errors", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const create = async (...args: any[]) => {
      const requestBody = args[0] as Record<string, unknown>;
      calls.push(requestBody);
      if (typeof requestBody.previous_response_id === "string") {
        throw {
          status: 400,
          message: "400 status code (no body)",
        };
      }

      return createEventStream([
        {
          type: "response.output_text.delta",
          delta: "fixed",
        },
        {
          type: "response.completed",
          response: {
            id: "resp-2",
            status: "completed",
          },
        },
      ]);
    };

    const client = {
      responses: {
        create,
      },
    } as any;

    const request: CompletionRequest = {
      profile: createProfile({
        baseUrl: "https://right.codes/codex/v1",
      }),
      model: "gpt-5.4",
      systemPrompt: "You are MoeCli.",
      messages: [
        createUserMessage("hello"),
        createAssistantMessage("hi there", "", []),
        createUserMessage("what can you do"),
      ],
      providerState: {
        previousResponseId: "resp-1",
        sentMessageCount: 2,
      },
    };

    const result = await collectStreamResult(
      streamOpenAIResponses("openai", client, request),
    );

    expect(result.assistantMessage.parts).toEqual([
      {
        type: "text",
        text: "fixed",
      },
    ]);
    expect(result.providerState).toEqual({
      supportsPreviousResponseId: false,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.previous_response_id).toBe("resp-1");
    expect(calls[1]?.previous_response_id).toBeUndefined();
    expect(calls[1]?.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hi there" }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "what can you do" }],
      },
    ]);
  });
});
