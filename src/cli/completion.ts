import {
  listInteractionModes,
  parseInteractionMode,
} from "./interactionMode.js";

export interface SlashCommandDefinition {
  command: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommandDefinition[] = [
  { command: "/", description: "show the command cheat sheet" },
  { command: "/help", description: "show the command list" },
  { command: "/status", description: "show current session details" },
  { command: "/providers", description: "add, edit, delete, or switch provider profiles" },
  { command: "/model", description: "pick a model or set one directly with /model <id>" },
  { command: "/mode", description: "switch between Chat & Edit mode and Task mode" },
  { command: "/config", description: "toggle browser, search, and agent defaults" },
  { command: "/browser", description: "inspect local browser integration and open a URL" },
  { command: "/clear", description: "start a fresh conversation" },
  { command: "/exit", description: "leave MoeCli" },
  { command: "/quit", description: "leave MoeCli" },
];

function startsWithCommandPrefix(
  command: SlashCommandDefinition,
  normalizedInput: string,
): boolean {
  return command.command.toLowerCase().startsWith(normalizedInput);
}

export function findSlashCommandSuggestions(
  input: string,
  limit = 5,
): SlashCommandDefinition[] {
  const normalizedInput = input.trim().toLowerCase();
  if (!normalizedInput.startsWith("/")) {
    return [];
  }

  const prefixMatches = SLASH_COMMANDS.filter((command) =>
    startsWithCommandPrefix(command, normalizedInput),
  );
  if (prefixMatches.length > 0) {
    return prefixMatches.slice(0, limit);
  }

  const token = normalizedInput.slice(1);
  if (!token) {
    return SLASH_COMMANDS.slice(0, limit);
  }

  return SLASH_COMMANDS.filter((command) => {
    const normalizedCommand = command.command.toLowerCase();
    return normalizedCommand.includes(token);
  }).slice(0, limit);
}

export function buildSlashCommandCompletions(
  line: string,
): [string[], string] | null {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const firstToken = trimmed.split(/\s+/, 1)[0] ?? trimmed;
  const hasArguments = trimmed.includes(" ") && !trimmed.endsWith(" ");
  if (hasArguments && !trimmed.startsWith("/model ")) {
    return null;
  }

  const suggestions = findSlashCommandSuggestions(firstToken, 50).map(
    (entry) => entry.command,
  );
  if (suggestions.length === 0) {
    return null;
  }

  return [suggestions, firstToken];
}

export function buildModelCompletions(
  line: string,
  models: string[],
): [string[], string] | null {
  const match = line.match(/^\/model\s+([^\s]*)$/);
  if (!match) {
    return null;
  }

  const partial = match[1] ?? "";
  const normalizedPartial = partial.toLowerCase();
  const uniqueModels = [...new Set(models.filter(Boolean))];
  const matches = uniqueModels.filter((model) =>
    model.toLowerCase().startsWith(normalizedPartial),
  );

  if (matches.length === 0) {
    return null;
  }

  return [matches, partial];
}

export function buildModeCompletions(
  line: string,
): [string[], string] | null {
  const match = line.match(/^\/mode\s+([^\s]*)$/);
  if (!match) {
    return null;
  }

  const partial = match[1] ?? "";
  const normalizedPartial = partial.toLowerCase();
  const matches = listInteractionModes()
    .flatMap((mode) => [mode.value, mode.promptTag])
    .filter((value, index, values) => values.indexOf(value) === index)
    .filter((value) => value.toLowerCase().startsWith(normalizedPartial));

  if (matches.length === 0) {
    const exact = parseInteractionMode(partial);
    return exact ? [[exact], partial] : null;
  }

  return [matches, partial];
}
