import "server-only";

import type {
  WorkspaceSession,
  WorkspaceSettings,
  WorkspaceSettingsSaveResponse,
  WorkspaceSettingsUpdate,
} from "@/schemas/cloud";

import {
  getStoredWorkspaceSettings,
  getWorkspaceSsoSecrets,
  getWorkspaceConnectionState,
  saveStoredWorkspaceSettings,
  saveWorkspaceSsoSecrets,
  saveWorkspaceConnectionState,
} from "@/lib/backend/workspace/cloud-state";

const DEFAULT_WORKSPACE_SETTINGS = {
  approvalTtlMinutes: 30,
  defaultNotificationChannel: "slack",
  freezeDeploysOutsideBusinessHours: false,
  requireRejectComment: true,
  enterpriseSso: {
    enabled: false,
    providerType: "oidc",
    providerLabel: "Enterprise SSO",
    issuerUrl: "https://idp.example.com/realms/agentgit",
    clientId: "agentgit-cloud",
    emailDomains: [],
    autoProvisionMembers: true,
    defaultRole: "member",
    clientSecretConfigured: false,
  },
} as const satisfies Pick<
  WorkspaceSettings,
  | "approvalTtlMinutes"
  | "defaultNotificationChannel"
  | "freezeDeploysOutsideBusinessHours"
  | "requireRejectComment"
  | "enterpriseSso"
>;

export async function resolveWorkspaceSettings(workspaceSession: WorkspaceSession): Promise<WorkspaceSettings> {
  const persistedSettings = await getStoredWorkspaceSettings(workspaceSession.activeWorkspace.id);
  const ssoSecrets = await getWorkspaceSsoSecrets(workspaceSession.activeWorkspace.id);
  if (persistedSettings) {
    return {
      ...persistedSettings,
      enterpriseSso: {
        ...persistedSettings.enterpriseSso,
        clientSecretConfigured: Boolean(ssoSecrets?.clientSecret),
      },
    };
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
    enterpriseSso: DEFAULT_WORKSPACE_SETTINGS.enterpriseSso,
  };
}

export async function saveWorkspaceSettings(
  workspaceSession: WorkspaceSession,
  settings: WorkspaceSettingsUpdate,
): Promise<WorkspaceSettingsSaveResponse> {
  const existingSecrets = await getWorkspaceSsoSecrets(workspaceSession.activeWorkspace.id);
  const nextClientSecret =
    typeof settings.enterpriseSso.clientSecret === "string" && settings.enterpriseSso.clientSecret.trim().length > 0
      ? settings.enterpriseSso.clientSecret.trim()
      : (existingSecrets?.clientSecret ?? null);

  if (settings.enterpriseSso.enabled && !nextClientSecret) {
    throw new Error("Enterprise SSO requires a client secret before it can be enabled.");
  }

  await saveWorkspaceSsoSecrets(workspaceSession.activeWorkspace.id, {
    clientSecret: settings.enterpriseSso.enabled ? nextClientSecret : null,
  });

  const savedSettings = await saveStoredWorkspaceSettings(workspaceSession.activeWorkspace.id, {
    ...settings,
    enterpriseSso: {
      enabled: settings.enterpriseSso.enabled,
      providerType: settings.enterpriseSso.providerType,
      providerLabel: settings.enterpriseSso.providerLabel,
      issuerUrl: settings.enterpriseSso.issuerUrl,
      clientId: settings.enterpriseSso.clientId,
      emailDomains: settings.enterpriseSso.emailDomains,
      autoProvisionMembers: settings.enterpriseSso.autoProvisionMembers,
      defaultRole: settings.enterpriseSso.defaultRole,
      clientSecretConfigured: settings.enterpriseSso.enabled ? Boolean(nextClientSecret) : false,
    },
  });
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
