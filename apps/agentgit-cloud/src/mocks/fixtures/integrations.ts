import {
  IntegrationTestResponseSchema,
  WorkspaceIntegrationSaveResponseSchema,
  WorkspaceIntegrationSnapshotSchema,
  type IntegrationTestChannel,
  type IntegrationTestResponse,
  type WorkspaceIntegrationSaveResponse,
  type WorkspaceIntegrationSnapshot,
  type WorkspaceIntegrationUpdate,
} from "@/schemas/cloud";

const integrationsFixture = WorkspaceIntegrationSnapshotSchema.parse({
  githubAppInstalled: true,
  githubAppStatus: "healthy",
  githubOrgName: "acme",
  webhookStatus: "warning",
  webhookLastDeliveryAt: "2026-04-07T15:48:00Z",
  webhookFailureCount24h: 2,
  slackConnected: true,
  slackWorkspaceName: "Acme Engineering",
  slackChannelName: "#agentgit-approvals",
  slackDeliveryMode: "approvals_only",
  emailNotificationsEnabled: true,
  digestCadence: "daily",
  notificationEvents: ["approval_requested", "run_failed", "policy_changed"],
});

export function getWorkspaceIntegrationsFixture(): WorkspaceIntegrationSnapshot {
  return integrationsFixture;
}

export function saveWorkspaceIntegrationsFixture(update: WorkspaceIntegrationUpdate): WorkspaceIntegrationSaveResponse {
  const integrations = WorkspaceIntegrationSnapshotSchema.parse({
    ...integrationsFixture,
    ...update,
    slackWorkspaceName: update.slackConnected ? update.slackWorkspaceName || integrationsFixture.slackWorkspaceName : undefined,
    slackChannelName: update.slackConnected ? update.slackChannelName || integrationsFixture.slackChannelName : undefined,
  });

  return WorkspaceIntegrationSaveResponseSchema.parse({
    integrations,
    savedAt: "2026-04-07T16:41:00Z",
    message: "Integrations saved. External delivery providers are still mocked.",
  });
}

export function sendIntegrationTestFixture(channel: IntegrationTestChannel): IntegrationTestResponse {
  return IntegrationTestResponseSchema.parse({
    channel,
    deliveredAt: "2026-04-07T16:47:00Z",
    message:
      channel === "slack"
        ? "Slack test delivered to the configured review channel."
        : channel === "email"
          ? "Email notification queued for the billing and invoice contacts."
          : "In-app notification added to the workspace bell feed.",
  });
}
