import chalk from "chalk";
import type { ProviderKind } from "../providers/types.js";

const primary = chalk.hex("#ff5ca8");
const primarySoft = chalk.hex("#ff90c4");
const primaryBold = chalk.hex("#ff2f87");
const success = chalk.hex("#39d98a");
const warning = chalk.hex("#ffbf69");
const danger = chalk.hex("#ff6b81");
const info = chalk.hex("#8fd8ff");
const muted = chalk.hex("#9a8ca5");

const providerPalette: Record<ProviderKind, (text: string) => string> = {
  openai: chalk.hex("#ff68b2"),
  "openai-compatible": chalk.hex("#ff89c4"),
  anthropic: chalk.hex("#ff3f92"),
  bedrock: chalk.hex("#ff9a73"),
  gemini: chalk.hex("#ff7db8"),
};

export const theme = {
  primary,
  primarySoft,
  primaryBold,
  success,
  warning,
  danger,
  info,
  muted,
  provider(kind: ProviderKind, text: string): string {
    return providerPalette[kind](text);
  },
  heading(text: string): string {
    return primaryBold(text);
  },
  label(text: string): string {
    return primary(text);
  },
  dim(text: string): string {
    return muted(text);
  },
};
