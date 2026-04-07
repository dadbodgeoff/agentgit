import "server-only";

import type { Session } from "next-auth";

import { auth } from "@/auth";
import { toWorkspaceSession } from "@/lib/auth/session-mapper";
import { getWorkspaceConnectionState } from "@/lib/backend/workspace/cloud-state";
import { resolveWorkspaceSettings } from "@/lib/backend/workspace/workspace-settings";
import type { WorkspaceSession } from "@/schemas/cloud";

export function resolveWorkspaceSession(session: Session | null): WorkspaceSession | null {
  const workspaceSession = toWorkspaceSession(session);

  if (!workspaceSession) {
    return null;
  }

  const persistedState = getWorkspaceConnectionState(workspaceSession.activeWorkspace.id);
  const persistedSettings = resolveWorkspaceSettings(workspaceSession);
  if (!persistedState) {
    return {
      ...workspaceSession,
      activeWorkspace: {
        ...workspaceSession.activeWorkspace,
        name: persistedSettings.workspaceName,
        slug: persistedSettings.workspaceSlug,
      },
    };
  }

  return {
    ...workspaceSession,
    activeWorkspace: {
      ...workspaceSession.activeWorkspace,
      id: persistedState.workspaceId,
      name: persistedSettings.workspaceName,
      slug: persistedSettings.workspaceSlug,
    },
  };
}

export async function getWorkspaceSession(): Promise<WorkspaceSession | null> {
  const session = await auth();
  return resolveWorkspaceSession(session);
}
