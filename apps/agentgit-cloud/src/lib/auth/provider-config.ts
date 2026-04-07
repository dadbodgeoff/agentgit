import { ActiveWorkspaceSchema, type WorkspaceRole } from "@/schemas/cloud";

import { isWorkspaceRole } from "@/lib/rbac/roles";

export const DEVELOPMENT_PROVIDER_ID = "development";
export const isProductionAuth = process.env.NODE_ENV === "production";

export const authFeatureFlags = {
  hasGitHubProvider: Boolean(process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET),
  enableDevelopmentCredentials: !isProductionAuth && process.env.AUTH_ENABLE_DEV_CREDENTIALS !== "false",
} as const;

export function getDefaultWorkspaceRole(): WorkspaceRole {
  const candidate = process.env.AUTH_DEFAULT_WORKSPACE_ROLE;
  return candidate && isWorkspaceRole(candidate) ? candidate : "admin";
}

export function getFallbackActiveWorkspace(role = getDefaultWorkspaceRole()) {
  return ActiveWorkspaceSchema.parse({
    id: process.env.AUTH_WORKSPACE_ID ?? "ws_acme_01",
    name: process.env.AUTH_WORKSPACE_NAME ?? "Acme platform",
    slug: process.env.AUTH_WORKSPACE_SLUG ?? "acme-platform",
    role,
  });
}
