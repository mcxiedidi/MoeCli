import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderAdapter } from "../providers/types.js";
import { getSettings, updateSettings } from "../config/settings.js";
import {
  saveSearchApiKey,
  executeToolCall,
  getBuiltInTools,
  type ToolExecutionContext,
} from "./registry.js";
import { createToolPermissionState } from "./permissions.js";

const model = vi.hoisted(() => ({
  streamResponse: vi.fn<ProviderAdapter["streamResponse"]>(),
}));
vi.mock("../providers/index.js", () => ({
  getProviderAdapter: () => ({ streamResponse: model.streamResponse }),
}));
import { ChatSession } from "../session/chatSession.js";

const page = {
  url: "https://nodejs.org/api/",
  title: "Node.js API",
  excerpts: ["AbortSignal.any combines signals."],
};
let appHome: string;
let requests: Request[];
let calls: Array<{ name: string; arguments: Record<string, unknown> }>;
let reply: (name: string) => unknown;

function context(
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    cwd: process.cwd(),
    profile: {
      meta: {
        id: "test",
        name: "Test",
        kind: "openai",
        enabled: true,
        createdAt: "2026-04-01T00:00:00Z",
        updatedAt: "2026-04-01T00:00:00Z",
      },
      secrets: { profileId: "test" },
    },
    model: "configured-model-slug",
    interactionMode: "chat-edit",
    browser: {} as ToolExecutionContext["browser"],
    agents: {} as ToolExecutionContext["agents"],
    permissions: createToolPermissionState(),
    ...overrides,
  };
}

function search(input: Record<string, unknown> = {}, ctx = context()) {
  return executeToolCall(
    {
      id: "search-1",
      name: "web_search",
      argumentsText: JSON.stringify({
        query: "Node.js abort signals",
        ...input,
      }),
    },
    ctx,
  );
}

function selectParallel() {
  updateSettings((settings) => ({
    ...settings,
    search: { ...settings.search, provider: "parallel" },
  }));
}

beforeEach(() => {
  appHome = mkdtempSync(join(tmpdir(), "moecli-parallel-"));
  vi.stubEnv("MOECLI_HOME", appHome);
  vi.stubEnv("MOECLI_SEARCH_API_KEY", "");
  vi.stubEnv("PARALLEL_API_KEY", "");
  requests = [];
  calls = [];
  model.streamResponse.mockReset();
  reply = (name) => ({
    content: [{ type: "text", text: JSON.stringify({ results: [page] }) }],
    structuredContent: {
      results: [
        {
          ...page,
          ...(name === "web_fetch"
            ? { full_content: "Full Node.js documentation" }
            : {}),
        },
      ],
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const request = new Request(url, init);
      requests.push(request);
      if (request.method === "GET") return new Response(null, { status: 405 });
      const body = await request.clone().json();
      if (!body.jsonrpc)
        return Response.json({ query: body.query, results: [page] });
      if (!body.id && body.id !== 0) return new Response(null, { status: 202 });
      let result: unknown;
      if (body.method === "initialize") {
        result = {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "fixture", version: "1" },
        };
      } else if (body.method === "tools/list") {
        result = {
          tools: ["web_search", "web_fetch"].map((name) => ({
            name,
            inputSchema: { type: "object" },
          })),
        };
      } else {
        calls.push(body.params);
        result = reply(body.params.name);
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(appHome, { recursive: true, force: true });
});

describe("Parallel search through the built-in dispatcher", () => {
  it("keeps fresh and legacy configurations on the custom provider", async () => {
    expect(getSettings().search.provider).toBe("custom");
    const result = await search();
    expect(result.isError).toBeUndefined();
    expect(requests[0]?.url).toBe("https://uapis.cn/api/v1/search/aggregate");
    expect(requests[0]?.headers.get("authorization")).toBeNull();
    writeFileSync(
      join(appHome, "settings.json"),
      JSON.stringify({
        search: {
          enabled: false,
          endpoint: "https://saved.example/search",
          defaultSite: "nodejs.org",
        },
      }),
    );
    expect(getSettings().search).toMatchObject({
      provider: "custom",
      enabled: false,
      endpoint: "https://saved.example/search",
      defaultSite: "nodejs.org",
    });
  });

  it("discovers and executes anonymous search/fetch without forwarding stored or environment keys", async () => {
    getSettings();
    await saveSearchApiKey("saved-custom-key");
    vi.stubEnv("MOECLI_SEARCH_API_KEY", "ambient-custom-key");
    vi.stubEnv("PARALLEL_API_KEY", "ambient-parallel-key");
    selectParallel();
    const ctx = context();
    const result = await search(
      { site: "nodejs.org", filetype: "html", fetch_full: true },
      ctx,
    );
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.output)).toMatchObject({
      search: { results: [page] },
      pages: { results: [{ full_content: "Full Node.js documentation" }] },
    });
    expect(calls.map((call) => call.name)).toEqual(["web_search", "web_fetch"]);
    expect(calls[0]?.arguments).toMatchObject({
      objective: "Node.js abort signals",
      search_queries: ["Node.js abort signals site:nodejs.org filetype:html"],
      model_name: "configured-model-slug",
    });
    expect(calls[1]?.arguments).toMatchObject({
      urls: [page.url],
      full_content: true,
      session_id: calls[0]?.arguments.session_id,
    });
    await search({}, ctx);
    expect(calls[2]?.arguments.session_id).toBe(calls[0]?.arguments.session_id);
    expect(requests.length).toBeGreaterThan(3);
    for (const request of requests) {
      expect(request.url).toBe("https://search.parallel.ai/mcp");
      expect(request.headers.get("user-agent")).toBe("MoeCli/0.1.1");
      expect(request.headers.get("authorization")).toBeNull();
    }
    updateSettings((settings) => ({
      ...settings,
      search: {
        ...settings.search,
        provider: "custom",
        endpoint: "https://saved.example/search",
      },
    }));
    await search();
    expect(requests.at(-1)?.url).toBe("https://saved.example/search");
    expect(requests.at(-1)?.headers.get("authorization")).toBe(
      "Bearer saved-custom-key",
    );
  });

  it("works with an empty secret store and uses only explicit full-page extraction", async () => {
    selectParallel();
    const result = await search();
    expect(result.isError).toBeUndefined();
    expect(result.output).toContain(page.url);
    expect(calls.map((call) => call.name)).toEqual(["web_search"]);
  });

  it("preserves saved filters while honoring per-call overrides", async () => {
    selectParallel();
    updateSettings((settings) => ({
      ...settings,
      search: {
        ...settings.search,
        defaultSite: "saved.example",
        defaultFiletype: "pdf",
        defaultFetchFull: true,
      },
    }));
    await search({ site: "nodejs.org", filetype: "html", fetch_full: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.arguments.search_queries).toEqual([
      "Node.js abort signals site:nodejs.org filetype:html",
    ]);
    await search();
    expect(calls[1]?.arguments.search_queries).toEqual([
      "Node.js abort signals site:saved.example filetype:pdf",
    ]);
    expect(calls[2]?.name).toBe("web_fetch");
    expect(getSettings().search.defaultSite).toBe("saved.example");
  });

  it("bounds full-page extraction to three results", async () => {
    selectParallel();
    reply = (name) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            results:
              name === "web_search"
                ? Array.from({ length: 5 }, (_, i) => ({
                    ...page,
                    url: `https://nodejs.org/api/${i}`,
                  }))
                : [page],
          }),
        },
      ],
    });
    expect((await search({ fetch_full: true })).isError).toBeUndefined();
    expect(calls[1]?.arguments.urls).toHaveLength(3);
  });

  it("honors disabled search and rejects unsupported saved or explicit filters before networking", async () => {
    selectParallel();
    updateSettings((settings) => ({
      ...settings,
      search: { ...settings.search, enabled: false },
    }));
    expect(await search()).toMatchObject({
      isError: true,
      output: expect.stringContaining("disabled"),
    });
    updateSettings((settings) => ({
      ...settings,
      search: { ...settings.search, enabled: true },
    }));
    for (const input of [
      { sort: "date" },
      { time_range: "week" },
      { query: " " },
    ]) {
      expect((await search(input)).isError).toBe(true);
    }
    updateSettings((settings) => ({
      ...settings,
      search: { ...settings.search, defaultTimeRange: "day" },
    }));
    expect((await search()).output).toContain("custom search provider");
    expect(requests).toHaveLength(0);
  });

  it("returns tool, malformed response and invalid URL errors without falling back", async () => {
    selectParallel();
    for (const response of [
      {
        isError: true,
        content: [{ type: "text", text: "Provider unavailable" }],
      },
      { content: [{ type: "text", text: "not json" }] },
      {
        content: [],
        structuredContent: {
          results: [{ ...page, url: "file:///etc/passwd" }],
        },
      },
    ]) {
      reply = () => response;
      expect((await search()).isError).toBe(true);
    }
    expect(
      requests.every(
        (request) => request.url === "https://search.parallel.ai/mcp",
      ),
    ).toBe(true);
  });

  it("propagates HTTP failures without falling back", async () => {
    selectParallel();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Service unavailable", { status: 503 })),
    );
    expect(await search()).toMatchObject({
      isError: true,
      output: expect.stringContaining("Service unavailable"),
    });
  });

  it("aborts in-flight network work on cancellation and on the 30-second deadline", async () => {
    selectParallel();
    const signals: AbortSignal[] = [];
    const fixtureFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init: RequestInit) => {
        const body = init.body ? JSON.parse(String(init.body)) : {};
        if (body.method !== "tools/call") return fixtureFetch(url, init);
        return new Promise<Response>((_resolve, reject) => {
          const signal = init.signal!;
          signals.push(signal);
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      }),
    );
    const controller = new AbortController();
    const cancelled = search({}, context({ signal: controller.signal }));
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    controller.abort(new Error("Search cancelled"));
    expect(await cancelled).toMatchObject({
      isError: true,
      output: expect.stringContaining("cancelled"),
    });
    expect(signals[0]?.aborted).toBe(true);
    const timeout = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeout.signal);
    const expired = search();
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    timeout.abort(new DOMException("Search timed out", "TimeoutError"));
    expect(await expired).toMatchObject({
      isError: true,
      output: expect.stringContaining("timed out"),
    });
    expect(signals[1]?.aborted).toBe(true);
  });

  it("delivers search URLs/excerpts to the next model turn through a scripted ChatSession", async () => {
    selectParallel();
    const ctx = context();
    const call = {
      id: "model-search",
      name: "web_search",
      argumentsText: '{"query":"Node.js abort signals"}',
    };
    const seen: string[] = [];
    model.streamResponse.mockImplementation(async function* (request) {
      const toolResult = request.messages.find(
        (message) => message.role === "tool",
      );
      if (!toolResult) {
        return {
          assistantMessage: {
            role: "assistant",
            parts: [{ type: "tool-call", call }],
            timestamp: "2026-04-01T00:00:00Z",
          },
          toolCalls: [call],
        };
      }
      seen.push(JSON.stringify(toolResult));
      return {
        assistantMessage: {
          role: "assistant",
          parts: [{ type: "text", text: `See ${page.url}` }],
          timestamp: "2026-04-01T00:00:00Z",
        },
        toolCalls: [],
      };
    });
    const session = new ChatSession({
      profile: ctx.profile,
      model: "active-model-verbatim",
      cwd: ctx.cwd,
      tools: getBuiltInTools(),
      toolContext: ctx,
    });
    const result = await session.send(
      "Find current Node.js abort documentation",
    );
    expect(JSON.stringify(result.assistantMessage)).toContain(page.url);
    expect(seen[0]).toContain(page.excerpts[0]);
    expect(calls[0]?.arguments.model_name).toBe("active-model-verbatim");
    const firstSessionId = calls[0]?.arguments.session_id;
    expect(firstSessionId).toEqual(expect.any(String));
    session.messages.length = 0;
    await session.send("Look again");
    expect(calls[1]?.arguments.session_id).toBe(firstSessionId);
    expect(ctx.permissions?.allowAllSession).toBe(false);
    expect(ctx.permissions?.allowedTools.size).toBe(0);
  });
});
