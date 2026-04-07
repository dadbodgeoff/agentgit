import type { Session } from "next-auth";

import { WorkspaceSessionSchema, type WorkspaceSession } from "@/schemas/cloud";

import { getDefaultWorkspaceRole, getFallbackActiveWorkspace } from "@/lib/auth/provider-config";

export function toWorkspaceSession(session: Session | null): WorkspaceSession | null {
  if (!session?.user) {
    return null;
  }

  const role = session.user.role ?? getDefaultWorkspaceRole();
  const activeWorkspace = session.activeWorkspace ?? getFallbackActiveWorkspace(role);

  return WorkspaceSessionSchema.parse({
    user: {
      id: session.user.id ?? session.user.email ?? "user_unknown",
      name: session.user.name ?? "Workspace user",
      email: session.user.email ?? "unknown@agentgit.dev",
    },
    activeWorkspace,
  });
}
