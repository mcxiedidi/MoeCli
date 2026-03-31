export interface SelectOption<T> {
  label: string;
  value: T;
  aliases?: readonly string[] | undefined;
}

function normalizeChoice(text: string): string {
  return text.trim().toLowerCase();
}

export function findSelectedOption<T>(
  answer: string,
  options: readonly SelectOption<T>[],
): SelectOption<T> | undefined {
  const normalized = normalizeChoice(answer);
  if (!normalized) {
    return undefined;
  }

  const numeric = Number(normalized);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= options.length) {
    return options[numeric - 1];
  }

  return options.find((option) => {
    const candidates = [
      option.label,
      String(option.value),
      ...(option.aliases ?? []),
    ].map(normalizeChoice);
    return candidates.includes(normalized);
  });
}
