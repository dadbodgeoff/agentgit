import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getCloudReadinessChecks, summarizeReadiness } from "@/lib/release/readiness";

describe("cloud readiness checks", () => {
  const tempDirs: string[] = [];
  const originalAuthSecret = process.env.AUTH_SECRET;
  const originalAuthUrl = process.env.AUTH_URL;
  const originalNextAuthSecret = process.env.NEXTAUTH_SECRET;
  const originalSentryDsn = process.env.SENTRY_DSN;
  const originalNextPublicSentryDsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  const originalSentryAuthToken = process.env.SENTRY_AUTH_TOKEN;
  const originalSentryOrg = process.env.SENTRY_ORG;
  const originalSentryProject = process.env.SENTRY_PROJECT;
  const originalVercel = process.env.VERCEL;
  const originalVercelEnv = process.env.VERCEL_ENV;
  const originalWorkspaceRoots = process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS;
  const originalUptimeMonitorUrl = process.env.AGENTGIT_UPTIME_MONITOR_URL;
  const originalRequestMetricsProvider = process.env.AGENTGIT_REQUEST_METRICS_PROVIDER;
  const originalDdApiKey = process.env.DD_API_KEY;
  const originalDatadogApiKey = process.env.DATADOG_API_KEY;
  const originalSentryAlertsConfigured = process.env.AGENTGIT_SENTRY_ALERTS_CONFIGURED;

  afterEach(() => {
    if (originalAuthSecret === undefined) {
      delete process.env.AUTH_SECRET;
    } else {
      process.env.AUTH_SECRET = originalAuthSecret;
    }

    if (originalAuthUrl === undefined) {
      delete process.env.AUTH_URL;
    } else {
      process.env.AUTH_URL = originalAuthUrl;
    }

    if (originalNextAuthSecret === undefined) {
      delete process.env.NEXTAUTH_SECRET;
    } else {
      process.env.NEXTAUTH_SECRET = originalNextAuthSecret;
    }

    if (originalWorkspaceRoots === undefined) {
      delete process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS;
    } else {
      process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS = originalWorkspaceRoots;
    }

    if (originalSentryDsn === undefined) {
      delete process.env.SENTRY_DSN;
    } else {
      process.env.SENTRY_DSN = originalSentryDsn;
    }

    if (originalNextPublicSentryDsn === undefined) {
      delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    } else {
      process.env.NEXT_PUBLIC_SENTRY_DSN = originalNextPublicSentryDsn;
    }

    if (originalSentryAuthToken === undefined) {
      delete process.env.SENTRY_AUTH_TOKEN;
    } else {
      process.env.SENTRY_AUTH_TOKEN = originalSentryAuthToken;
    }

    if (originalSentryOrg === undefined) {
      delete process.env.SENTRY_ORG;
    } else {
      process.env.SENTRY_ORG = originalSentryOrg;
    }

    if (originalSentryProject === undefined) {
      delete process.env.SENTRY_PROJECT;
    } else {
      process.env.SENTRY_PROJECT = originalSentryProject;
    }

    if (originalVercel === undefined) {
      delete process.env.VERCEL;
    } else {
      process.env.VERCEL = originalVercel;
    }

    if (originalVercelEnv === undefined) {
      delete process.env.VERCEL_ENV;
    } else {
      process.env.VERCEL_ENV = originalVercelEnv;
    }

    if (originalUptimeMonitorUrl === undefined) {
      delete process.env.AGENTGIT_UPTIME_MONITOR_URL;
    } else {
      process.env.AGENTGIT_UPTIME_MONITOR_URL = originalUptimeMonitorUrl;
    }

    if (originalRequestMetricsProvider === undefined) {
      delete process.env.AGENTGIT_REQUEST_METRICS_PROVIDER;
    } else {
      process.env.AGENTGIT_REQUEST_METRICS_PROVIDER = originalRequestMetricsProvider;
    }

    if (originalDdApiKey === undefined) {
      delete process.env.DD_API_KEY;
    } else {
      process.env.DD_API_KEY = originalDdApiKey;
    }

    if (originalDatadogApiKey === undefined) {
      delete process.env.DATADOG_API_KEY;
    } else {
      process.env.DATADOG_API_KEY = originalDatadogApiKey;
    }

    if (originalSentryAlertsConfigured === undefined) {
      delete process.env.AGENTGIT_SENTRY_ALERTS_CONFIGURED;
    } else {
      process.env.AGENTGIT_SENTRY_ALERTS_CONFIGURED = originalSentryAlertsConfigured;
    }

    for (const tempDir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("reports ok when auth, telemetry, and workspace roots are configured", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-readiness-"));
    tempDirs.push(tempDir);
    process.env.AUTH_SECRET = "secret";
    process.env.AUTH_URL = "https://cloud.agentgit.dev";
    process.env.SENTRY_DSN = "https://public@example.ingest.sentry.io/1";
    process.env.SENTRY_AUTH_TOKEN = "token";
    process.env.SENTRY_ORG = "agentgit";
    process.env.SENTRY_PROJECT = "agentgit-cloud";
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "preview";
    process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS = tempDir;
    process.env.AGENTGIT_UPTIME_MONITOR_URL = "https://betterstack.com/monitors/agentgit-cloud";
    process.env.AGENTGIT_REQUEST_METRICS_PROVIDER = "vercel";
    process.env.AGENTGIT_SENTRY_ALERTS_CONFIGURED = "true";

    const checks = getCloudReadinessChecks();

    expect(checks.find((check) => check.id === "auth_secret")?.level).toBe("ok");
    expect(checks.find((check) => check.id === "auth_base_url")?.level).toBe("ok");
    expect(checks.find((check) => check.id === "workspace_roots_configured")?.level).toBe("ok");
    expect(checks.find((check) => check.id === "workspace_roots_available")?.level).toBe("ok");
    expect(checks.find((check) => check.id === "sentry_dsn")?.level).toBe("ok");
    expect(checks.find((check) => check.id === "vercel_analytics")?.level).toBe("ok");
    expect(checks.find((check) => check.id === "uptime_monitoring")?.level).toBe("ok");
    expect(checks.find((check) => check.id === "request_metrics")?.level).toBe("ok");
    expect(checks.find((check) => check.id === "sentry_alerts")?.level).toBe("ok");
  });

  it("summarizes readiness to warn when no failing checks exist but warnings do", () => {
    const level = summarizeReadiness([
      { level: "ok" },
      { level: "warn" },
    ]);

    expect(level).toBe("warn");
  });
});
