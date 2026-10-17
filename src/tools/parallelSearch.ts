import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const ENDPOINT = "https://search.parallel.ai/mcp";
const TIMEOUT_MS = 30_000;
const sessionIds = new WeakMap<object, string>();
const SearchResponseSchema = z
  .object({
    results: z.array(
      z
        .object({
          url: z
            .string()
            .url()
            .refine(
              (url) => /^https?:\/\//i.test(url),
              "Expected an HTTP(S) result URL",
            ),
          excerpts: z.array(z.string()),
        })
        .passthrough(),
    ),
  })
  .passthrough();

interface SearchContext {
  model: string;
  sessionId?: string | undefined;
  signal?: AbortSignal | undefined;
}

export async function runParallelSearch(
  payload: Record<string, unknown>,
  context: SearchContext,
): Promise<string> {
  const query = String(payload.query ?? "").trim();
  if (!query) {
    throw new Error("Search query must not be empty.");
  }
  if (payload.sort === "date" || payload.time_range) {
    throw new Error(
      "Parallel does not support sort=date or time_range. Use the custom search provider for these filters.",
    );
  }

  let sessionId = context.sessionId ?? sessionIds.get(context);
  if (!sessionId) {
    sessionId = randomUUID();
    sessionIds.set(context, sessionId);
  }
  const metadata = {
    session_id: sessionId,
    ...(context.model && context.model.length <= 100
      ? { model_name: context.model }
      : {}),
  };
  const searchQuery = [
    query,
    payload.site ? `site:${payload.site}` : "",
    payload.filetype ? `filetype:${payload.filetype}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const signal = context.signal
    ? AbortSignal.any([context.signal, AbortSignal.timeout(TIMEOUT_MS)])
    : AbortSignal.timeout(TIMEOUT_MS);
  signal.throwIfAborted();

  const client = new Client({ name: "MoeCli", version: "0.1.1" });
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    requestInit: { headers: { "User-Agent": "MoeCli/0.1.1" } },
    fetch: (url, init) =>
      fetch(url, {
        ...init,
        signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
      }),
  });

  try {
    // The SDK's optional Transport.sessionId type omits undefined under
    // exactOptionalPropertyTypes, although its HTTP implementation returns it.
    await client.connect(transport as Transport);
    const { tools } = await client.listTools({}, { signal });
    const requiredTools = payload.fetch_full
      ? ["web_search", "web_fetch"]
      : ["web_search"];
    for (const name of requiredTools) {
      if (!tools.some((tool) => tool.name === name)) {
        throw new Error(`Parallel MCP does not advertise ${name}.`);
      }
    }

    async function call(name: string, args: Record<string, unknown>) {
      const result = CallToolResultSchema.parse(
        await client.callTool(
          { name, arguments: { ...args, ...metadata } },
          CallToolResultSchema,
          { signal },
        ),
      );
      const text = result.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      if (result.isError) {
        throw new Error(text || `Parallel ${name} failed.`);
      }
      const data = result.structuredContent ?? JSON.parse(text);
      return SearchResponseSchema.parse(data);
    }

    const search = await call("web_search", {
      objective: query,
      search_queries: [searchQuery],
    });
    if (!payload.fetch_full || !search.results.length) {
      return JSON.stringify(search, null, 2);
    }
    // Bound extraction to avoid fetching every search result automatically.
    const pages = await call("web_fetch", {
      urls: search.results.slice(0, 3).map((result) => result.url),
      objective: query.slice(0, 200),
      search_queries: [searchQuery],
      full_content: true,
    });
    // Put fetched pages first so they survive the dispatcher's output limit.
    return JSON.stringify({ pages, search }, null, 2);
  } finally {
    await client.close();
  }
}
