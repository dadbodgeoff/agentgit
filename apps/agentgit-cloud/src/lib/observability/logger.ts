import "server-only";

type LogLevel = "debug" | "info" | "warn" | "error";

const severityOrder: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function resolveMinimumLogLevel(): LogLevel {
  const configured = process.env.AGENTGIT_CLOUD_LOG_LEVEL?.trim().toLowerCase();
  if (configured === "debug" || configured === "info" || configured === "warn" || configured === "error") {
    return configured;
  }

  return "info";
}

export function logServerEvent(level: LogLevel, event: string, details: Record<string, unknown> = {}): void {
  if (severityOrder[level] < severityOrder[resolveMinimumLogLevel()]) {
    return;
  }

  const payload = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...details,
  };
  const message = JSON.stringify(payload);

  if (level === "error") {
    console.error(message);
    return;
  }

  if (level === "warn") {
    console.warn(message);
    return;
  }

  console.log(message);
}
