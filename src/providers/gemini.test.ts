import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiProviderAdapter } from "./gemini.js";
import type { CompletionRequest, ResolvedProviderProfile } from "./types.js";
import { createUserMessage } from "./helpers.js";

const originalFetch = globalThis.fetch;

function createProfile(baseUrl = "https://www.right.codes/gemini"): ResolvedProviderProfile {
  return {
    meta: {
      id: "gemini-profile",
      name: "RightCode",
      kind: "gemini",
      enabled: true,
      createdAt: "2026-04-01T00:00:00.000Z",
      updatedAt: "2026-04-01T00:00:00.000Z",
      baseUrl,
    },
    secrets: {
      profileId: "gemini-profile",
      apiKey: "test-key",
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

describe("GeminiProviderAdapter", () => {
  it("fails validation when models.list returns HTML", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response("<!doctype html><html></html>", {
        status: 200,
        headers: {
          "content-type": "text/html",
        },
      });
    }) as typeof fetch;

    const adapter = new GeminiProviderAdapter();
    const result = await adapter.validateProfile(createProfile());

    expect(result.ok).toBe(false);
    expect(result.message).toContain("returned HTML instead of JSON");
  });

  it("rejects chat requests when the endpoint does not return an SSE stream", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response("<!doctype html><html></html>", {
        status: 200,
        headers: {
          "content-type": "text/html",
        },
      });
    }) as typeof fetch;

    const adapter = new GeminiProviderAdapter();
    const request: CompletionRequest = {
      profile: createProfile(),
      model: "gemini-2.5-pro",
      messages: [createUserMessage("hi")],
      systemPrompt: "You are MoeCli.",
    };

    await expect(adapter.streamResponse(request).next()).rejects.toThrow(
      "returned HTML instead of an event stream",
    );
  });
});
