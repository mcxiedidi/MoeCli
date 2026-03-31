import { theme } from "./theme.js";

export type PanelTone = "primary" | "success" | "warning" | "danger" | "info";

interface PanelOptions {
  tone?: PanelTone;
  minWidth?: number;
  maxWidth?: number;
}

interface KeyValueRow {
  label: string;
  value: string | number | boolean | undefined;
}

interface CommandRow {
  command: string;
  description: string;
}

const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex
  /\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

function visibleWidth(text: string): number {
  return stripAnsi(text).length;
}

function hardTruncate(text: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return "";
  }

  const plain = stripAnsi(text);
  if (plain.length <= maxWidth) {
    return plain;
  }

  if (maxWidth <= 3) {
    return ".".repeat(maxWidth);
  }

  return `${plain.slice(0, maxWidth - 3)}...`;
}

function wrapLine(text: string, width: number): string[] {
  const plain = stripAnsi(text);
  if (!plain) {
    return [""];
  }

  if (plain.length <= width) {
    return [plain];
  }

  const output: string[] = [];
  let remaining = plain;

  while (remaining.length > width) {
    const slice = remaining.slice(0, width);
    const breakIndex = slice.lastIndexOf(" ");
    const cut = breakIndex >= Math.floor(width * 0.55) ? breakIndex : width;
    output.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining.length > 0) {
    output.push(remaining);
  }

  return output;
}

function padLine(text: string, width: number): string {
  const truncated = hardTruncate(text, width);
  const padding = Math.max(0, width - visibleWidth(truncated));
  return `${truncated}${" ".repeat(padding)}`;
}

function getToneFormatter(tone: PanelTone): (text: string) => string {
  switch (tone) {
    case "success":
      return theme.success;
    case "warning":
      return theme.warning;
    case "danger":
      return theme.danger;
    case "info":
      return theme.info;
    default:
      return theme.primaryBold;
  }
}

export function renderPanel(
  title: string,
  lines: string[],
  options: PanelOptions = {},
): string {
  const tone = options.tone ?? "primary";
  const minWidth = options.minWidth ?? 44;
  const maxWidth = Math.max(minWidth, options.maxWidth ?? 88);
  const normalizedLines = lines.flatMap((line) => line.split(/\r?\n/));
  const initialWidth = Math.max(
    minWidth,
    visibleWidth(title),
    Math.max(0, visibleWidth(`-- ${title} `) - 2),
    ...normalizedLines.map((line) => visibleWidth(line)),
  );
  const contentWidth = Math.min(initialWidth, maxWidth);
  const wrappedLines = normalizedLines.flatMap((line) => wrapLine(line, contentWidth));
  const borderWidth = contentWidth + 2;
  const toneFormat = getToneFormatter(tone);
  const visibleTitle = hardTruncate(title, Math.max(1, borderWidth - 4));
  const titlePrefix = `-- ${visibleTitle} `;
  const topBorder = toneFormat(
    `+${titlePrefix}${"-".repeat(Math.max(0, borderWidth - visibleWidth(titlePrefix)))}+`,
  );
  const bottomBorder = toneFormat(`+${"-".repeat(borderWidth)}+`);
  const bodyRows = wrappedLines.map((line) => `| ${padLine(line, contentWidth)} |`);

  return [topBorder, ...bodyRows, bottomBorder].join("\n");
}

export function renderKeyValueRows(rows: KeyValueRow[]): string[] {
  const filtered = rows.filter((row) => row.value !== undefined && row.value !== "");
  const labelWidth = Math.max(0, ...filtered.map((row) => row.label.length));
  return filtered.map((row) => {
    return `${row.label.padEnd(labelWidth)} : ${String(row.value)}`;
  });
}

export function renderCommandRows(rows: CommandRow[]): string[] {
  const labelWidth = Math.max(0, ...rows.map((row) => row.command.length));
  return rows.map((row) => {
    return `${row.command.padEnd(labelWidth)}  ${row.description}`;
  });
}
