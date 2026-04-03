export function lines(...values: Array<string | null | undefined | false>): string {
  return values.filter((value): value is string => typeof value === "string" && value.length > 0).join("\n");
}

export function bulletList(items: string[], indent = "  "): string {
  return items.map((item) => `${indent}- ${item}`).join("\n");
}

export function clipText(value: string, maxChars = 320, maxLines = 4): string {
  const clippedChars = value.length > maxChars ? `${value.slice(0, maxChars - 3)}...` : value;
  const lineParts = clippedChars.split(/\r?\n/);

  if (lineParts.length <= maxLines) {
    return clippedChars;
  }

  return `${lineParts.slice(0, maxLines).join("\n")}\n...`;
}

export function indentBlock(value: string, spaces = 2): string {
  const prefix = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

export function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function formatBudget(used: number, limit: number | null): string {
  return limit === null ? `${used} / unlimited` : `${used} / ${limit}`;
}

export function joinOrNone(items: string[]): string {
  return items.length > 0 ? items.join(", ") : "none";
}

export function maybeLine(label: string, value: string | null | undefined): string | null {
  return value ? `${label}: ${value}` : null;
}

export function formatTimestamp(value: string | null | undefined): string {
  return value ?? "unknown";
}
