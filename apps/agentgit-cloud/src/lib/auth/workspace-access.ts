import "server-only";

import type { ActiveWorkspace, WorkspaceRole } from "@/schemas/cloud";

import {
  findWorkspaceAccessMatchesForIdentity,
  saveWorkspaceConnectionState,
  upsertCloudUser,
} from "@/lib/backend/workspace/cloud-state";
import {
  getBootstrapWorkspaceRole,
  getFallbackActiveWorkspace,
  isBootstrapIdentityMatch,
} from "@/lib/auth/provider-config";

type WorkspaceIdentity = {
  email?: string | null;
  login?: string | null;
};

type ResolvedWorkspaceAccess = {
  activeWorkspace: ActiveWorkspace;
  role: WorkspaceRole;
  source: "member" | "invite" | "bootstrap";
};

function normalizeEmail(value?: string | null): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function buildResolvedWorkspaceAccess(params: {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  role: WorkspaceRole;
  source: ResolvedWorkspaceAccess["source"];
}): ResolvedWorkspaceAccess {
  return {
    activeWorkspace: {
      id: params.workspaceId,
      name: params.workspaceName,
      slug: params.workspaceSlug,
      role: params.role,
    },
    role: params.role,
    source: params.source,
  };
}

async function provisionBootstrapWorkspaceAccess(identity: WorkspaceIdentity): Promise<ResolvedWorkspaceAccess | null> {
  if (!identity.email) {
    return null;
  }

  const role = getBootstrapWorkspaceRole();
  const activeWorkspace = getFallbackActiveWorkspace(role);
  const launchedAt = new Date().toISOString();

  await upsertCloudUser({
    email: identity.email,
    githubLogin: identity.login ?? null,
    name: identity.email.split("@")[0] ?? "Workspace owner",
  });
  await saveWorkspaceConnectionState({
    workspaceId: activeWorkspace.id,
    workspaceName: activeWorkspace.name,
    workspaceSlug: activeWorkspace.slug,
    repositoryIds: [],
    members: [
      {
        name: identity.email.split("@")[0] ?? "Workspace owner",
        email: identity.email,
        role,
      },
    ],
    invites: [],
    defaultNotificationChannel: "in_app",
    policyPack: "guarded",
    launchedAt,
  });

  return {
    activeWorkspace,
    role,
    source: "bootstrap",
  };
}

export async function resolveWorkspaceAccessForIdentity(identity: WorkspaceIdentity): Promise<ResolvedWorkspaceAccess | null> {
  const email = normalizeEmail(identity.email);
  const matches: ResolvedWorkspaceAccess[] = [];

  if (email) {
    for (const workspace of await findWorkspaceAccessMatchesForIdentity({
      email,
      login: identity.login,
    })) {
      matches.push(
        buildResolvedWorkspaceAccess({
          workspaceId: workspace.workspaceId,
          workspaceName: workspace.workspaceName,
          workspaceSlug: workspace.workspaceSlug,
          role: workspace.role,
          source: workspace.source,
        }),
      );
    }
  }

  if (matches.length > 1) {
    return null;
  }

  if (matches.length === 1) {
    return matches[0]!;
  }

  if (!isBootstrapIdentityMatch(identity)) {
    return null;
  }

  return provisionBootstrapWorkspaceAccess(identity);
}
