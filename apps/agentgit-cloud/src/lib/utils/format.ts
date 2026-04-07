export function formatRelativeTimestamp(isoTimestamp: string): string {
  const now = Date.now();
  const target = new Date(isoTimestamp).getTime();
  const deltaSeconds = Math.max(0, Math.round((now - target) / 1000));

  if (deltaSeconds < 60) {
    return "just now";
  }
  if (deltaSeconds < 3600) {
    return `${Math.floor(deltaSeconds / 60)}m ago`;
  }
  if (deltaSeconds < 86400) {
    return `${Math.floor(deltaSeconds / 3600)}h ago`;
  }
  return `${Math.floor(deltaSeconds / 86400)}d ago`;
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(value > 0.99 || value < 0.01 ? 1 : 0)}%`;
}

export function formatConfidence(value: number): string {
  return value.toFixed(2);
}
