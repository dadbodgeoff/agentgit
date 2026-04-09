import { ActiveWorkspaceSchema, type WorkspaceRole } from "@/schemas/cloud";

import { isWorkspaceRole } from "@/lib/rbac/roles";

export const DEVELOPMENT_PROVIDER_ID = "development";
export const ENTERPRISE_PROVIDER_PREFIX = "enterprise-";
export const isProductionAuth = process.env.NODE_ENV === "production";
export const allowDevelopmentCredentialsInProduction =
  isProductionAuth && process.env.AUTH_ALLOW_DEV_CREDENTIALS_IN_PRODUCTION === "true";

export const authFeatureFlags = {
  hasGitHubProvider: Boolean(process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET),
  enableDevelopmentCredentials:
    process.env.AUTH_ENABLE_DEV_CREDENTIALS !== "false" &&
    (!isProductionAuth || allowDevelopmentCredentialsInProduction),
} as const;

export function getDefaultWorkspaceRole(): WorkspaceRole {
  const candidate = process.env.AUTH_DEFAULT_WORKSPACE_ROLE;
  return candidate && isWorkspaceRole(candidate) ? candidate : "member";
}

export function getBootstrapWorkspaceRole(): WorkspaceRole {
  const candidate = process.env.AUTH_BOOTSTRAP_WORKSPACE_ROLE;
  return candidate && isWorkspaceRole(candidate) ? candidate : "owner";
}

export function getFallbackActiveWorkspace(role = getDefaultWorkspaceRole()) {
  return ActiveWorkspaceSchema.parse({
    id: process.env.AUTH_WORKSPACE_ID ?? "ws_acme_01",
    name: process.env.AUTH_WORKSPACE_NAME ?? "Acme platform",
    slug: process.env.AUTH_WORKSPACE_SLUG ?? "acme-platform",
    role,
  });
}

export function isBootstrapIdentityMatch(identity: { email?: string | null; login?: string | null }): boolean {
  const configuredEmail = process.env.AUTH_BOOTSTRAP_USER_EMAIL?.trim().toLowerCase() ?? null;
  const configuredLogin = process.env.AUTH_BOOTSTRAP_GITHUB_LOGIN?.trim().toLowerCase() ?? null;
  const email = identity.email?.trim().toLowerCase() ?? null;
  const login = identity.login?.trim().toLowerCase() ?? null;

  if (!configuredEmail && !configuredLogin) {
    return false;
  }

  if (configuredEmail && email === configuredEmail) {
    return true;
  }

  if (configuredLogin && login === configuredLogin) {
    return true;
  }

  return false;
}

export function buildEnterpriseProviderId(workspaceSlug: string): string {
  return `${ENTERPRISE_PROVIDER_PREFIX}${workspaceSlug.trim().toLowerCase()}`;
}
