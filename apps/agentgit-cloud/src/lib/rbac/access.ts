import { getWorkspaceSession } from "@/lib/auth/workspace-session";
import type { WorkspaceRole } from "@/schemas/cloud";

import { hasAtLeastRole } from "@/lib/rbac/roles";

export async function getRoleAccess(requiredRole: WorkspaceRole) {
  const session = await getWorkspaceSession();
  const currentRole = session?.activeWorkspace.role;

  return {
    session,
    allowed: currentRole ? hasAtLeastRole(currentRole, requiredRole) : false,
    requiredRole,
  };
}
