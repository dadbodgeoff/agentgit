import "server-only";

import { getCloudRuntimeChecks, type RuntimeCheck } from "@/lib/release/runtime-config";

export type ReadinessCheck = RuntimeCheck;
export { summarizeReadiness } from "@/lib/release/runtime-config";

const operationalWarningChecks = new Set([
  "cloud_database_configured",
  "dev_credentials",
  "uptime_monitoring",
  "request_metrics",
  "sentry_alerts",
]);

export function getCloudReadinessChecks(): ReadinessCheck[] {
  return getCloudRuntimeChecks();
}

export function summarizeOperationalHealth(
  checks: Array<{ id: string; level: "ok" | "warn" | "fail" }>,
): "ok" | "warn" | "fail" {
  const normalizedChecks = checks.map((check) =>
    check.level === "fail" && operationalWarningChecks.has(check.id) ? { ...check, level: "warn" as const } : check,
  );

  if (normalizedChecks.some((check) => check.level === "fail")) {
    return "fail";
  }

  if (normalizedChecks.some((check) => check.level === "warn")) {
    return "warn";
  }

  return "ok";
}
