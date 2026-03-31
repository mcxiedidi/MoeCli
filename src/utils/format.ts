import type { ProviderKind } from "../providers/types.js";
import { theme } from "./theme.js";

export function formatProvider(kind: ProviderKind): string {
  return theme.provider(kind, kind);
}

export function formatDim(text: string): string {
  return theme.dim(text);
}

export function formatHeading(text: string): string {
  return theme.heading(text);
}

export function formatLabel(text: string): string {
  return theme.label(text);
}

export function formatSuccess(text: string): string {
  return theme.success(text);
}

export function formatWarning(text: string): string {
  return theme.warning(text);
}

export function formatError(text: string): string {
  return theme.danger(text);
}

export function formatInfo(text: string): string {
  return theme.info(text);
}
