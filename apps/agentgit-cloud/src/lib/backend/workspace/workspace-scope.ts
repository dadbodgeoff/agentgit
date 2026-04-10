import "server-only";

import type { WorkspaceSession } from "@/schemas/cloud";
import {
  findStoredWorkspaceSettingsBySlug,
  findWorkspaceConnectionStateBySlug,
  getStoredWorkspaceSettings,
  getWorkspaceConnectionState,
} from "@/lib/backend/workspace/cloud-state";

function normalizeWorkspaceSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

export async function isWorkspaceSlugOwnedByAnotherWorkspace(
  workspaceSlug: string,
  workspaceId: string,
): Promise<boolean> {
  const normalizedSlug = normalizeWorkspaceSlug(workspaceSlug);
  const [matchingState, matchingSettings] = await Promise.all([
    findWorkspaceConnectionStateBySlug(normalizedSlug),
    findStoredWorkspaceSettingsBySlug(normalizedSlug),
  ]);

  return [matchingState?.workspaceId, matchingSettings?.workspaceId].some(
    (matchingWorkspaceId) => matchingWorkspaceId !== undefined && matchingWorkspaceId !== workspaceId,
  );
}

export async function hasPersistedWorkspaceScope(workspaceSession: WorkspaceSession): Promise<boolean> {
  const [connectionState, storedSettings] = await Promise.all([
    getWorkspaceConnectionState(workspaceSession.activeWorkspace.id),
    getStoredWorkspaceSettings(workspaceSession.activeWorkspace.id),
  ]);

  if (!connectionState && !storedSettings) {
    return false;
  }

  const expectedSlug = normalizeWorkspaceSlug(workspaceSession.activeWorkspace.slug);
  if (connectionState && normalizeWorkspaceSlug(connectionState.workspaceSlug) !== expectedSlug) {
    return false;
  }

  if (storedSettings && normalizeWorkspaceSlug(storedSettings.workspaceSlug) !== expectedSlug) {
    return false;
  }

  return true;
}
