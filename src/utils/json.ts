import type { JsonValue } from "../types/shared.js";

export function safeJsonParse<T = JsonValue>(
  value: string,
): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

export function toPrettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function toSingleLineJson(value: unknown): string {
  return JSON.stringify(value);
}
