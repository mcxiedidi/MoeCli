import type {
  CompletionRequest,
  CompletionResult,
  ModelDescriptor,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderValidationResult,
  ResolvedProviderProfile,
  UnifiedStreamEvent,
  UnifiedToolCall,
} from "./types.js";
import {
  collectToolCalls,
  createAssistantMessage,
  getMessageText,
  normalizeUsage,
  toModelDescriptor,
  tryParseToolArguments,
} from "./helpers.js";
import { getSuggestedModels } from "../config/providerDefaults.js";
import { UserError } from "../utils/errors.js";
import { safeJsonParse } from "../utils/json.js";

const DEFAULT_GEMINI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta";

const capabilities: ProviderCapabilities = {
  streaming: true,
  toolCalling: true,
  modelListing: true,
  reasoningDeltas: false,
  toolCallDeltas: false,
};

function getGeminiBaseUrl(profile: ResolvedProviderProfile): string {
  return profile.meta.baseUrl?.trim() || DEFAULT_GEMINI_BASE_URL;
}

function getGeminiApiKey(profile: ResolvedProviderProfile): string {
  if (!profile.secrets.apiKey?.trim()) {
    throw new UserError(`Profile "${profile.meta.name}" is missing an API key.`);
  }
  return profile.secrets.apiKey;
}

function buildGeminiUrl(
  profile: ResolvedProviderProfile,
  path: string,
): string {
  const url = new URL(
    `${getGeminiBaseUrl(profile).replace(/\/$/, "")}/${path.replace(/^\//, "")}`,
  );
  url.searchParams.set("key", getGeminiApiKey(profile));
  return url.toString();
}

function buildGeminiContents(
  request: CompletionRequest,
): Array<Record<string, unknown>> {
  const contents: Array<Record<string, unknown>> = [];

  for (const message of request.messages) {
    if (message.role === "system") {
      continue;
    }

    if (message.role === "tool") {
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: message.toolName,
              response: {
                output: getMessageText(message),
                error: Boolean(message.isError),
              },
            },
          },
        ],
      });
      continue;
    }

    if (message.role === "assistant") {
      const parts: Array<Record<string, unknown>> = [];
      if (getMessageText(message).trim()) {
        parts.push({ text: getMessageText(message) });
      }
      for (const call of collectToolCalls(message.parts)) {
        parts.push({
          functionCall: {
            name: call.name,
            args: tryParseToolArguments(call.argumentsText),
          },
        });
      }
      contents.push({
        role: "model",
        parts,
      });
      continue;
    }

    contents.push({
      role: "user",
      parts: [{ text: getMessageText(message) }],
    });
  }

  return contents;
}

function getContentType(response: Response): string {
  return response.headers.get("content-type")?.toLowerCase() ?? "";
}

async function readGeminiText(response: Response): Promise<string> {
  return (await response.text()).trim();
}

function buildGeminiBaseUrlHint(profile: ResolvedProviderProfile): string {
  const configured = profile.meta.baseUrl?.trim();
  if (!configured) {
    return `Try the official Gemini API base URL: ${DEFAULT_GEMINI_BASE_URL}`;
  }

  return `Check that "${configured}" is a Gemini API base URL. The official default is ${DEFAULT_GEMINI_BASE_URL}.`;
}

async function parseGeminiJsonResponse<T>(
  profile: ResolvedProviderProfile,
  response: Response,
  operation: string,
): Promise<T> {
  const contentType = getContentType(response);
  const raw = await response.text();
  const text = raw.trim();

  if (!response.ok) {
    throw new Error(text || `Gemini ${operation} failed with HTTP ${response.status}.`);
  }

  if (!contentType.includes("json")) {
    if (text.startsWith("<") || contentType.includes("html")) {
      throw new Error(
        `Gemini ${operation} returned HTML instead of JSON. ${buildGeminiBaseUrlHint(profile)}`,
      );
    }

    throw new Error(
      `Gemini ${operation} returned content-type "${contentType || "unknown"}" instead of JSON. ${buildGeminiBaseUrlHint(profile)}`,
    );
  }

  const parsed = safeJsonParse<T>(text);
  if (!parsed) {
    throw new Error(
      `Gemini ${operation} returned invalid JSON. ${buildGeminiBaseUrlHint(profile)}`,
    );
  }

  return parsed;
}

async function parseSseStream(
  response: Response,
  onData: (payload: Record<string, unknown>) => void,
): Promise<number> {
  if (!response.body) {
    return 0;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventCount = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    while (buffer.includes("\n\n")) {
      const index = buffer.indexOf("\n\n");
      const rawEvent = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);

      const dataLines = rawEvent
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .filter(Boolean);

      for (const dataLine of dataLines) {
        if (dataLine === "[DONE]") {
          return eventCount;
        }
        const parsed = safeJsonParse<Record<string, unknown>>(dataLine);
        if (parsed) {
          eventCount += 1;
          onData(parsed);
        }
      }
    }
  }

  return eventCount;
}

export class GeminiProviderAdapter implements ProviderAdapter {
  readonly kind = "gemini" as const;
  readonly displayName = "Google Gemini";

  getCapabilities(): ProviderCapabilities {
    return capabilities;
  }

  getSuggestedModels(profile: ResolvedProviderProfile): ModelDescriptor[] {
    return getSuggestedModels(profile);
  }

  async validateProfile(
    profile: ResolvedProviderProfile,
  ): Promise<ProviderValidationResult> {
    try {
      const response = await fetch(buildGeminiUrl(profile, "models"));
      await parseGeminiJsonResponse<{ models?: unknown[] }>(
        profile,
        response,
        "models.list",
      );
      return {
        ok: true,
        message: "Gemini endpoint responded to models.list.",
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async listModels(profile: ResolvedProviderProfile): Promise<ModelDescriptor[]> {
    const response = await fetch(buildGeminiUrl(profile, "models"));
    const payload = await parseGeminiJsonResponse<{
      models?: Array<{
        name?: string;
        displayName?: string;
        supportedGenerationMethods?: string[];
      }>;
    }>(profile, response, "models.list");

    return (payload.models ?? [])
      .filter((model) => model.name)
      .map((model) => {
        const raw =
          model.supportedGenerationMethods?.length
            ? {
                supportedGenerationMethods: model.supportedGenerationMethods,
              }
            : undefined;

        return toModelDescriptor(
          (model.name ?? "").replace(/^models\//, ""),
          model.displayName ?? model.name ?? "Gemini Model",
          this.kind,
          "remote",
          raw,
        );
      });
  }

  async *streamResponse(
    request: CompletionRequest,
  ): AsyncGenerator<UnifiedStreamEvent, CompletionResult> {
    const toolCalls = new Map<string, UnifiedToolCall>();
    let text = "";
    let finishReason: string | undefined;
    let usage: CompletionResult["usage"];

    const response = await fetch(
      buildGeminiUrl(
        request.profile,
        `models/${request.model}:streamGenerateContent?alt=sse`,
      ),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...request.profile.meta.extraHeaders,
        },
        body: JSON.stringify({
          contents: buildGeminiContents(request),
          ...(request.systemPrompt?.trim()
            ? {
                systemInstruction: {
                  parts: [{ text: request.systemPrompt }],
                },
              }
            : {}),
          ...(request.tools?.length
            ? {
                tools: [
                  {
                    functionDeclarations: request.tools.map((tool) => ({
                      name: tool.name,
                      description: tool.description,
                      parameters: tool.inputSchema,
                    })),
                  },
                ],
              }
            : {}),
          generationConfig: {
            temperature: request.temperature,
            maxOutputTokens: request.maxOutputTokens,
          },
        }),
        ...(request.signal ? { signal: request.signal } : {}),
      },
    );

    if (!response.ok) {
      throw new Error(await readGeminiText(response));
    }

    const contentType = getContentType(response);
    if (!contentType.includes("text/event-stream")) {
      const raw = await readGeminiText(response);
      if (raw.startsWith("<") || contentType.includes("html")) {
        throw new Error(
          `Gemini generateContent returned HTML instead of an event stream. ${buildGeminiBaseUrlHint(request.profile)}`,
        );
      }

      throw new Error(
        `Gemini generateContent returned content-type "${contentType || "unknown"}" instead of text/event-stream. ${buildGeminiBaseUrlHint(request.profile)}`,
      );
    }

    yield { type: "message-start" };

    const eventCount = await parseSseStream(response, (payload) => {
      const candidates = Array.isArray(payload.candidates)
        ? (payload.candidates as Array<Record<string, unknown>>)
        : [];

      for (const candidate of candidates) {
        const content = candidate.content as
          | { parts?: Array<Record<string, unknown>> }
          | undefined;
        for (const part of content?.parts ?? []) {
          if (typeof part.text === "string" && part.text) {
            text += part.text;
          }

          const functionCall = part.functionCall as
            | { name?: string; args?: unknown }
            | undefined;
          if (functionCall?.name) {
            const callId = `gemini-${toolCalls.size + 1}`;
            const call: UnifiedToolCall = {
              id: callId,
              name: functionCall.name,
              argumentsText: JSON.stringify(functionCall.args ?? {}),
            };
            toolCalls.set(callId, call);
          }
        }

        if (typeof candidate.finishReason === "string") {
          finishReason = candidate.finishReason;
        }
      }

      usage = normalizeUsage(
        payload.usageMetadata as Record<string, unknown> | undefined,
      );
    });

    if (!text && toolCalls.size === 0 && !finishReason && eventCount === 0) {
      throw new Error(
        `Gemini generateContent returned no stream events. ${buildGeminiBaseUrlHint(request.profile)}`,
      );
    }

    if (text) {
      yield { type: "text-delta", delta: text };
    }

    for (const call of toolCalls.values()) {
      yield { type: "tool-call", call };
    }

    if (usage) {
      yield { type: "usage", usage };
    }

    yield { type: "message-stop", finishReason };

    return {
      assistantMessage: createAssistantMessage(text, "", [...toolCalls.values()]),
      toolCalls: [...toolCalls.values()],
      ...(finishReason ? { finishReason } : {}),
      ...(usage ? { usage } : {}),
    };
  }
}
