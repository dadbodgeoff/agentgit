import "server-only";

import { authFeatureFlags, isProductionAuth } from "@/lib/auth/provider-config";
import { resolveWorkspaceRoots } from "@/lib/backend/workspace/roots";

type ReadinessLevel = "ok" | "warn" | "fail";

export type ReadinessCheck = {
  id: string;
  level: ReadinessLevel;
  message: string;
};

export function getCloudReadinessChecks(): ReadinessCheck[] {
  const authSecret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  const sentryDsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;
  const workspaceRoots = resolveWorkspaceRoots();
  const sentryBuildConfigReady = Boolean(
    process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT,
  );
  const vercelAnalyticsReady = process.env.VERCEL === "1" || Boolean(process.env.VERCEL_ENV);

  return [
    {
      id: "auth_secret",
      level: authSecret ? "ok" : isProductionAuth ? "fail" : "warn",
      message: authSecret
        ? "Authentication secret is configured."
        : isProductionAuth
          ? "Authentication secret is missing for production."
          : "Authentication secret is using development fallback behavior.",
    },
    {
      id: "github_provider",
      level: authFeatureFlags.hasGitHubProvider ? "ok" : isProductionAuth ? "fail" : "warn",
      message: authFeatureFlags.hasGitHubProvider
        ? "GitHub OAuth provider is configured."
        : isProductionAuth
          ? "GitHub OAuth provider is missing in production."
          : "GitHub OAuth provider is not configured in this environment.",
    },
    {
      id: "dev_credentials",
      level: authFeatureFlags.enableDevelopmentCredentials && isProductionAuth ? "fail" : "ok",
      message:
        authFeatureFlags.enableDevelopmentCredentials && isProductionAuth
          ? "Development credentials are enabled in production."
          : authFeatureFlags.enableDevelopmentCredentials
            ? "Development credentials remain available for local testing."
            : "Development credentials are disabled.",
    },
    {
      id: "workspace_roots",
      level: workspaceRoots.length > 0 ? "ok" : "fail",
      message:
        workspaceRoots.length > 0
          ? `${workspaceRoots.length} workspace root${workspaceRoots.length === 1 ? "" : "s"} configured.`
          : "No workspace roots are configured.",
    },
    {
      id: "sentry_dsn",
      level: sentryDsn ? "ok" : isProductionAuth ? "fail" : "warn",
      message: sentryDsn
        ? "Sentry DSN is configured."
        : isProductionAuth
          ? "Sentry DSN is missing for production telemetry."
          : "Sentry DSN is not configured in this environment.",
    },
    {
      id: "sentry_source_maps",
      level: sentryBuildConfigReady ? "ok" : isProductionAuth ? "fail" : "warn",
      message: sentryBuildConfigReady
        ? "Sentry source map upload credentials are configured."
        : isProductionAuth
          ? "Sentry source map upload credentials are missing in production."
          : "Sentry source map upload credentials are not configured in this environment.",
    },
    {
      id: "vercel_analytics",
      level: vercelAnalyticsReady ? "ok" : isProductionAuth ? "fail" : "warn",
      message: vercelAnalyticsReady
        ? "Vercel deployment environment detected for analytics."
        : isProductionAuth
          ? "Vercel deployment environment variables are missing for production analytics."
          : "Vercel deployment environment variables are not set in this environment.",
    },
  ];
}

export function summarizeReadiness(checks: ReadinessCheck[]): ReadinessLevel {
  if (checks.some((check) => check.level === "fail")) {
    return "fail";
  }

  if (checks.some((check) => check.level === "warn")) {
    return "warn";
  }

  return "ok";
}
