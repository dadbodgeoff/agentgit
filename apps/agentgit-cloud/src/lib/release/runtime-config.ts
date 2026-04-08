import fs from "node:fs";
import path from "node:path";

import { authFeatureFlags, isProductionAuth } from "@/lib/auth/provider-config";

export type ReadinessLevel = "ok" | "warn" | "fail";

export type RuntimeCheck = {
  id: string;
  level: ReadinessLevel;
  message: string;
};

export type CloudRuntimeSummary = {
  mode: "development" | "production";
  authBaseUrl: string | null;
  agentgitRoot: string;
  workspaceRoots: string[];
  checks: RuntimeCheck[];
  status: ReadinessLevel;
};

function resolveConfiguredAuthSecret(): string | null {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? null;
  return secret && secret.trim().length > 0 ? secret.trim() : null;
}

function resolveAuthBaseUrl(): string | null {
  const baseUrl = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? null;
  return baseUrl && baseUrl.trim().length > 0 ? baseUrl.trim() : null;
}

function resolveAgentGitRoot(): string {
  return process.env.AGENTGIT_ROOT?.trim() || process.cwd();
}

function resolveWorkspaceRootsFromEnvironment(): string[] {
  const configuredRoots = process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS;
  if (configuredRoots) {
    return configuredRoots
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }

  return [resolveAgentGitRoot()];
}

function pathExists(candidate: string): boolean {
  try {
    return fs.existsSync(candidate);
  } catch {
    return false;
  }
}

function existingWorkspaceRoots(workspaceRoots: string[]): string[] {
  return workspaceRoots.filter((candidate) => pathExists(candidate));
}

export function summarizeReadiness(checks: Array<{ level: ReadinessLevel }>): ReadinessLevel {
  if (checks.some((check) => check.level === "fail")) {
    return "fail";
  }

  if (checks.some((check) => check.level === "warn")) {
    return "warn";
  }

  return "ok";
}

export function getCloudRuntimeChecks(): RuntimeCheck[] {
  const authSecret = resolveConfiguredAuthSecret();
  const authBaseUrl = resolveAuthBaseUrl();
  const workspaceRoots = resolveWorkspaceRootsFromEnvironment();
  const availableWorkspaceRoots = existingWorkspaceRoots(workspaceRoots);
  const agentgitRoot = resolveAgentGitRoot();
  const sentryDsn = process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN;
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
      id: "auth_base_url",
      level: authBaseUrl ? "ok" : isProductionAuth ? "fail" : "warn",
      message: authBaseUrl
        ? `Authentication base URL is configured as ${authBaseUrl}.`
        : isProductionAuth
          ? "AUTH_URL or NEXTAUTH_URL must be set in production."
          : "Authentication base URL is not set; local development will infer it from the incoming request.",
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
      id: "agentgit_root",
      level: pathExists(agentgitRoot) ? "ok" : "fail",
      message: pathExists(agentgitRoot)
        ? `AgentGit root is available at ${path.resolve(agentgitRoot)}.`
        : `AgentGit root does not exist: ${path.resolve(agentgitRoot)}.`,
    },
    {
      id: "workspace_roots_configured",
      level: workspaceRoots.length > 0 ? "ok" : "fail",
      message:
        workspaceRoots.length > 0
          ? `${workspaceRoots.length} workspace root${workspaceRoots.length === 1 ? "" : "s"} configured.`
          : "No workspace roots are configured.",
    },
    {
      id: "workspace_roots_available",
      level: availableWorkspaceRoots.length === workspaceRoots.length ? "ok" : "fail",
      message:
        availableWorkspaceRoots.length === workspaceRoots.length
          ? "All configured workspace roots are present on disk."
          : `Only ${availableWorkspaceRoots.length} of ${workspaceRoots.length} configured workspace roots are available on disk.`,
    },
    {
      id: "sentry_dsn",
      level: sentryDsn ? "ok" : "warn",
      message: sentryDsn
        ? "Sentry DSN is configured."
        : isProductionAuth
          ? "Sentry DSN is missing for production telemetry."
          : "Sentry DSN is not configured in this environment.",
    },
    {
      id: "sentry_source_maps",
      level: sentryBuildConfigReady ? "ok" : "warn",
      message: sentryBuildConfigReady
        ? "Sentry source map upload credentials are configured."
        : isProductionAuth
          ? "Sentry source map upload credentials are missing in production."
          : "Sentry source map upload credentials are not configured in this environment.",
    },
    {
      id: "vercel_analytics",
      level: vercelAnalyticsReady ? "ok" : "warn",
      message: vercelAnalyticsReady
        ? "Vercel deployment environment detected for analytics."
        : isProductionAuth
          ? "Vercel deployment environment variables are missing for production analytics."
          : "Vercel deployment environment variables are not set in this environment.",
    },
  ];
}

export function getCloudRuntimeSummary(): CloudRuntimeSummary {
  const checks = getCloudRuntimeChecks();

  return {
    mode: isProductionAuth ? "production" : "development",
    authBaseUrl: resolveAuthBaseUrl(),
    agentgitRoot: resolveAgentGitRoot(),
    workspaceRoots: resolveWorkspaceRootsFromEnvironment(),
    checks,
    status: summarizeReadiness(checks),
  };
}
