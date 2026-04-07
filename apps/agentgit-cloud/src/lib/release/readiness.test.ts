import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getCloudReadinessChecks, summarizeReadiness } from "@/lib/release/readiness";

describe("cloud readiness checks", () => {
  const originalAuthSecret = process.env.AUTH_SECRET;
  const originalNextAuthSecret = process.env.NEXTAUTH_SECRET;
  const originalSentryDsn = process.env.SENTRY_DSN;
  const originalNextPublicSentryDsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  const originalSentryAuthToken = process.env.SENTRY_AUTH_TOKEN;
  const originalSentryOrg = process.env.SENTRY_ORG;
  const originalSentryProject = process.env.SENTRY_PROJECT;
  const originalVercel = process.env.VERCEL;
  const originalVercelEnv = process.env.VERCEL_ENV;
  const originalWorkspaceRoots = process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS;

  afterEach(() => {
    if (originalAuthSecret === undefined) {
      delete process.env.AUTH_SECRET;
    } else {
      process.env.AUTH_SECRET = originalAuthSecret;
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
  });

  it("reports ok when auth, telemetry, and workspace roots are configured", () => {
    process.env.AUTH_SECRET = "secret";
    process.env.SENTRY_DSN = "https://public@example.ingest.sentry.io/1";
    process.env.SENTRY_AUTH_TOKEN = "token";
    process.env.SENTRY_ORG = "agentgit";
    process.env.SENTRY_PROJECT = "agentgit-cloud";
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "preview";
    process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS = "/tmp/workspace";

    const checks = getCloudReadinessChecks();

    expect(checks.find((check) => check.id === "auth_secret")?.level).toBe("ok");
    expect(checks.find((check) => check.id === "workspace_roots")?.level).toBe("ok");
    expect(checks.find((check) => check.id === "sentry_dsn")?.level).toBe("ok");
    expect(checks.find((check) => check.id === "vercel_analytics")?.level).toBe("ok");
  });

  it("summarizes readiness to warn when no failing checks exist but warnings do", () => {
    const level = summarizeReadiness([
      { id: "a", level: "ok", message: "ok" },
      { id: "b", level: "warn", message: "warn" },
    ]);

    expect(level).toBe("warn");
  });
});
