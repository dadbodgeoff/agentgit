import "server-only";

import type { ActiveWorkspace, WorkspaceRole } from "@/schemas/cloud";

import { listWorkspaceConnectionStates } from "@/lib/backend/workspace/cloud-state";
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

export function resolveWorkspaceAccessForIdentity(identity: WorkspaceIdentity): ResolvedWorkspaceAccess | null {
  const email = normalizeEmail(identity.email);
  const matches: ResolvedWorkspaceAccess[] = [];

  if (email) {
    for (const workspace of listWorkspaceConnectionStates()) {
      const member = workspace.members.find((entry) => normalizeEmail(entry.email) === email);
      if (member) {
        matches.push(
          buildResolvedWorkspaceAccess({
            workspaceId: workspace.workspaceId,
            workspaceName: workspace.workspaceName,
            workspaceSlug: workspace.workspaceSlug,
            role: member.role,
            source: "member",
          }),
        );
        continue;
      }

      const invite = workspace.invites.find((entry) => normalizeEmail(entry.email) === email);
      if (invite) {
        matches.push(
          buildResolvedWorkspaceAccess({
            workspaceId: workspace.workspaceId,
            workspaceName: workspace.workspaceName,
            workspaceSlug: workspace.workspaceSlug,
            role: invite.role,
            source: "invite",
          }),
        );
      }
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

  const role = getBootstrapWorkspaceRole();
  return {
    activeWorkspace: getFallbackActiveWorkspace(role),
    role,
    source: "bootstrap",
  };
}
