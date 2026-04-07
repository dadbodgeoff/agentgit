import {
  WorkspaceSettingsSaveResponseSchema,
  WorkspaceSettingsSchema,
  type WorkspaceSettings,
  type WorkspaceSettingsSaveResponse,
} from "@/schemas/cloud";

const workspaceSettingsFixture = WorkspaceSettingsSchema.parse({
  workspaceName: "Acme platform",
  workspaceSlug: "acme-platform",
  defaultNotificationChannel: "slack",
  approvalTtlMinutes: 30,
  requireRejectComment: true,
  freezeDeploysOutsideBusinessHours: false,
});

export function getWorkspaceSettingsFixture(): WorkspaceSettings {
  return workspaceSettingsFixture;
}

export function saveWorkspaceSettingsFixture(settings: WorkspaceSettings): WorkspaceSettingsSaveResponse {
  return WorkspaceSettingsSaveResponseSchema.parse({
    settings,
    savedAt: "2026-04-07T14:12:00Z",
    message: "Settings saved.",
  });
}
