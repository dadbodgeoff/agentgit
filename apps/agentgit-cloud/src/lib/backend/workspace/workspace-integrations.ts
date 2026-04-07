import "server-only";

import type {
  IntegrationTestChannel,
  IntegrationTestResponse,
  WorkspaceIntegrationSaveResponse,
  WorkspaceIntegrationSnapshot,
  WorkspaceIntegrationUpdate,
  WorkspaceSession,
} from "@/schemas/cloud";

import { getStoredWorkspaceIntegrations, saveStoredWorkspaceIntegrations } from "@/lib/backend/workspace/cloud-state";
import { collectWorkspaceRepositoryRuntimeRecords } from "@/lib/backend/workspace/repository-inventory";

function deriveGitHubOrgName(workspaceId: string, workspaceSlug: string): string {
  return collectWorkspaceRepositoryRuntimeRecords(workspaceId)[0]?.inventory.owner ?? workspaceSlug;
}

function resolveWebhookStatus(repositoryCount: number) {
  if (repositoryCount === 0) {
    return "warning" as const;
  }

  return "healthy" as const;
}

export function resolveWorkspaceIntegrations(workspaceSession: WorkspaceSession): WorkspaceIntegrationSnapshot {
  const stored = getStoredWorkspaceIntegrations(workspaceSession.activeWorkspace.id);
  const repositoryCount = collectWorkspaceRepositoryRuntimeRecords(workspaceSession.activeWorkspace.id).length;

  if (stored) {
    return {
      ...stored,
      githubOrgName: deriveGitHubOrgName(
        workspaceSession.activeWorkspace.id,
        workspaceSession.activeWorkspace.slug,
      ),
      githubAppInstalled: repositoryCount > 0 || stored.githubAppInstalled,
      githubAppStatus: repositoryCount > 0 ? "healthy" : stored.githubAppStatus,
      webhookStatus: resolveWebhookStatus(repositoryCount),
    };
  }

  return {
    githubAppInstalled: repositoryCount > 0,
    githubAppStatus: repositoryCount > 0 ? "healthy" : "warning",
    githubOrgName: deriveGitHubOrgName(workspaceSession.activeWorkspace.id, workspaceSession.activeWorkspace.slug),
    webhookStatus: resolveWebhookStatus(repositoryCount),
    webhookLastDeliveryAt: "2026-04-07T15:48:00Z",
    webhookFailureCount24h: repositoryCount > 0 ? 0 : 1,
    slackConnected: true,
    slackWorkspaceName: "Acme Engineering",
    slackChannelName: "#agentgit-approvals",
    slackDeliveryMode: "approvals_only",
    emailNotificationsEnabled: true,
    digestCadence: "daily",
    notificationEvents: ["approval_requested", "run_failed", "policy_changed"],
  };
}

export function saveWorkspaceIntegrations(
  workspaceSession: WorkspaceSession,
  update: WorkspaceIntegrationUpdate,
): WorkspaceIntegrationSaveResponse {
  const current = resolveWorkspaceIntegrations(workspaceSession);
  saveStoredWorkspaceIntegrations(workspaceSession.activeWorkspace.id, {
    ...current,
    ...update,
    slackWorkspaceName: update.slackConnected ? update.slackWorkspaceName || current.slackWorkspaceName : undefined,
    slackChannelName: update.slackConnected ? update.slackChannelName || current.slackChannelName : undefined,
  });

  return {
    integrations: resolveWorkspaceIntegrations(workspaceSession),
    savedAt: new Date().toISOString(),
    message: "Integrations saved.",
  };
}

export function sendWorkspaceIntegrationTest(
  workspaceSession: WorkspaceSession,
  channel: IntegrationTestChannel,
): IntegrationTestResponse {
  const integrations = resolveWorkspaceIntegrations(workspaceSession);

  if (channel === "slack" && (!integrations.slackConnected || integrations.slackDeliveryMode === "disabled")) {
    throw new Error("Slack delivery is not configured for this workspace.");
  }

  if (channel === "email" && !integrations.emailNotificationsEnabled) {
    throw new Error("Email delivery is disabled for this workspace.");
  }

  const deliveredAt = new Date().toISOString();
  saveStoredWorkspaceIntegrations(workspaceSession.activeWorkspace.id, {
    ...integrations,
    webhookLastDeliveryAt: deliveredAt,
    webhookStatus: "healthy",
  });

  return {
    channel,
    deliveredAt,
    message:
      channel === "slack"
        ? `Slack test delivered to ${integrations.slackChannelName ?? "the configured channel"}.`
        : channel === "email"
          ? "Email notification queued for the configured delivery contacts."
          : "In-app notification added to the workspace activity feed.",
  };
}
