import "server-only";

import type { WorkspaceSession, WorkspaceSettings, WorkspaceSettingsSaveResponse } from "@/schemas/cloud";

import {
  getStoredWorkspaceSettings,
  getWorkspaceConnectionState,
  saveStoredWorkspaceSettings,
  saveWorkspaceConnectionState,
} from "@/lib/backend/workspace/cloud-state";

const DEFAULT_WORKSPACE_SETTINGS = {
  approvalTtlMinutes: 30,
  defaultNotificationChannel: "slack",
  freezeDeploysOutsideBusinessHours: false,
  requireRejectComment: true,
} as const satisfies Pick<
  WorkspaceSettings,
  "approvalTtlMinutes" | "defaultNotificationChannel" | "freezeDeploysOutsideBusinessHours" | "requireRejectComment"
>;

export async function resolveWorkspaceSettings(workspaceSession: WorkspaceSession): Promise<WorkspaceSettings> {
  const persistedSettings = await getStoredWorkspaceSettings(workspaceSession.activeWorkspace.id);
  if (persistedSettings) {
    return persistedSettings;
  }

  const workspaceState = await getWorkspaceConnectionState(workspaceSession.activeWorkspace.id);

  return {
    workspaceName: workspaceState?.workspaceName ?? workspaceSession.activeWorkspace.name,
    workspaceSlug: workspaceState?.workspaceSlug ?? workspaceSession.activeWorkspace.slug,
    defaultNotificationChannel:
      workspaceState?.defaultNotificationChannel ?? DEFAULT_WORKSPACE_SETTINGS.defaultNotificationChannel,
    approvalTtlMinutes: DEFAULT_WORKSPACE_SETTINGS.approvalTtlMinutes,
    requireRejectComment: DEFAULT_WORKSPACE_SETTINGS.requireRejectComment,
    freezeDeploysOutsideBusinessHours: DEFAULT_WORKSPACE_SETTINGS.freezeDeploysOutsideBusinessHours,
  };
}

export async function saveWorkspaceSettings(
  workspaceSession: WorkspaceSession,
  settings: WorkspaceSettings,
): Promise<WorkspaceSettingsSaveResponse> {
  const savedSettings = await saveStoredWorkspaceSettings(workspaceSession.activeWorkspace.id, settings);
  const workspaceState = await getWorkspaceConnectionState(workspaceSession.activeWorkspace.id);

  if (workspaceState) {
    await saveWorkspaceConnectionState({
      ...workspaceState,
      workspaceName: savedSettings.workspaceName,
      workspaceSlug: savedSettings.workspaceSlug,
      defaultNotificationChannel: savedSettings.defaultNotificationChannel,
    });
  }

  return {
    settings: savedSettings,
    savedAt: new Date().toISOString(),
    message: "Settings saved.",
  };
}
