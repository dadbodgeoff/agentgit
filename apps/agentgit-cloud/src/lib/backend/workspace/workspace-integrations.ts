import "server-only";

import type { ApprovalInboxItem } from "@agentgit/schemas";

import type {
  IntegrationTestChannel,
  IntegrationTestResponse,
  NotificationBusinessDay,
  NotificationEvent,
  NotificationRule,
  WorkspaceIntegrationSaveResponse,
  WorkspaceIntegrationSnapshot,
  WorkspaceNotificationBusinessHours,
  WorkspaceIntegrationUpdate,
  WorkspaceSession,
} from "@/schemas/cloud";

import {
  getStoredWorkspaceIntegrations,
  getWorkspaceConnectionState,
  getWorkspaceIntegrationSecrets,
  saveStoredWorkspaceIntegrations,
  saveWorkspaceIntegrationSecrets,
} from "@/lib/backend/workspace/cloud-state";

const NOTIFICATION_EVENTS: NotificationEvent[] = [
  "approval_requested",
  "run_failed",
  "policy_changed",
  "snapshot_restored",
];
const DEFAULT_NOTIFICATION_BUSINESS_DAYS: NotificationBusinessDay[] = ["mon", "tue", "wed", "thu", "fri"];

type NotificationDeliveryResult = {
  deliveredAt: string | null;
  failures: string[];
  sent: Array<"email" | "slack" | "in_app">;
};

function normalizeWebhookUrl(value?: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function getSlackWebhookUrlFromEnvironment(): string | null {
  return normalizeWebhookUrl(process.env.AGENTGIT_SLACK_WEBHOOK_URL ?? process.env.SLACK_WEBHOOK_URL ?? null);
}

function getResendApiKey(): string | null {
  return normalizeWebhookUrl(process.env.RESEND_API_KEY ?? null);
}

function getEmailFromAddress(): string | null {
  return normalizeWebhookUrl(process.env.AGENTGIT_EMAIL_FROM ?? process.env.RESEND_FROM_EMAIL ?? null);
}

function getDefaultNotificationTimeZone() {
  return process.env.AGENTGIT_NOTIFICATION_TIME_ZONE ?? "America/New_York";
}

function buildDefaultNotificationBusinessHours(): WorkspaceNotificationBusinessHours {
  return {
    timeZone: getDefaultNotificationTimeZone(),
    startTime: "09:00",
    endTime: "17:00",
    weekdays: DEFAULT_NOTIFICATION_BUSINESS_DAYS,
  };
}

function buildDefaultNotificationRule(event: NotificationEvent): NotificationRule {
  return {
    event,
    repositoryScope: "all",
    repositoryTargets: [],
    deliveryWindow: "anytime",
    minimumRiskLevel: "read_only",
  };
}

function normalizeNotificationRules(rules?: NotificationRule[] | null): NotificationRule[] {
  const byEvent = new Map<NotificationEvent, NotificationRule>();
  for (const rule of rules ?? []) {
    if (!byEvent.has(rule.event)) {
      byEvent.set(rule.event, rule);
    }
  }

  return NOTIFICATION_EVENTS.map((event) => byEvent.get(event) ?? buildDefaultNotificationRule(event));
}

function normalizeWorkspaceIntegrationsSnapshot(snapshot: WorkspaceIntegrationSnapshot): WorkspaceIntegrationSnapshot {
  return {
    ...snapshot,
    notificationBusinessHours: snapshot.notificationBusinessHours ?? buildDefaultNotificationBusinessHours(),
    notificationRules: normalizeNotificationRules(snapshot.notificationRules),
  };
}

async function deriveGitHubOrgName(workspaceId: string, workspaceSlug: string): Promise<string> {
  const workspaceState = await getWorkspaceConnectionState(workspaceId);
  return workspaceState?.workspaceSlug ?? workspaceSlug;
}

function resolveWebhookStatus(repositoryCount: number) {
  if (repositoryCount === 0) {
    return "warning" as const;
  }

  return "healthy" as const;
}

function buildDefaultIntegrations(params: {
  repositoryCount: number;
  workspaceSlug: string;
  githubOrgName: string;
  slackWebhookConfigured: boolean;
}): WorkspaceIntegrationSnapshot {
  return {
    githubAppInstalled: params.repositoryCount > 0,
    githubAppStatus: params.repositoryCount > 0 ? "healthy" : "warning",
    githubOrgName: params.githubOrgName,
    webhookStatus: resolveWebhookStatus(params.repositoryCount),
    webhookLastDeliveryAt: "2026-04-07T15:48:00Z",
    webhookFailureCount24h: params.repositoryCount > 0 ? 0 : 1,
    slackConnected: false,
    slackWebhookConfigured: params.slackWebhookConfigured,
    slackWorkspaceName: "Acme Engineering",
    slackChannelName: "#agentgit-approvals",
    slackDeliveryMode: "approvals_only",
    emailNotificationsEnabled: Boolean(getResendApiKey() && getEmailFromAddress()),
    digestCadence: "daily",
    notificationEvents: ["approval_requested", "run_failed", "policy_changed"],
    notificationBusinessHours: buildDefaultNotificationBusinessHours(),
    notificationRules: normalizeNotificationRules(),
  };
}

async function resolveWorkspaceIntegrationsByWorkspace(params: {
  workspaceId: string;
  workspaceSlug: string;
}): Promise<WorkspaceIntegrationSnapshot> {
  const [stored, workspaceState, secrets] = await Promise.all([
    getStoredWorkspaceIntegrations(params.workspaceId),
    getWorkspaceConnectionState(params.workspaceId),
    getWorkspaceIntegrationSecrets(params.workspaceId),
  ]);
  const repositoryCount = workspaceState?.repositoryIds.length ?? 0;
  const slackWebhookConfigured = Boolean(secrets?.slackWebhookUrl ?? getSlackWebhookUrlFromEnvironment());
  const githubOrgName = await deriveGitHubOrgName(params.workspaceId, params.workspaceSlug);

  if (stored) {
    return normalizeWorkspaceIntegrationsSnapshot({
      ...stored,
      githubOrgName,
      githubAppInstalled: repositoryCount > 0 || stored.githubAppInstalled,
      githubAppStatus: repositoryCount > 0 ? "healthy" : stored.githubAppStatus,
      webhookStatus: resolveWebhookStatus(repositoryCount),
      slackWebhookConfigured,
    });
  }

  return buildDefaultIntegrations({
    repositoryCount,
    workspaceSlug: params.workspaceSlug,
    githubOrgName,
    slackWebhookConfigured,
  });
}

async function resolveSlackWebhookUrl(workspaceId: string): Promise<string | null> {
  const secrets = await getWorkspaceIntegrationSecrets(workspaceId);
  return secrets?.slackWebhookUrl ?? getSlackWebhookUrlFromEnvironment();
}

async function resolveWorkspaceMemberEmails(workspaceId: string): Promise<string[]> {
  const workspaceState = await getWorkspaceConnectionState(workspaceId);
  if (!workspaceState) {
    return [];
  }

  return Array.from(
    new Set(
      workspaceState.members.map((member) => member.email.trim().toLowerCase()).filter((email) => email.length > 0),
    ),
  );
}

async function persistDeliveryStatus(
  workspaceId: string,
  integrations: WorkspaceIntegrationSnapshot,
  params: {
    deliveredAt: string | null;
    success: boolean;
  },
) {
  await saveStoredWorkspaceIntegrations(workspaceId, {
    ...integrations,
    webhookStatus: params.success ? "healthy" : "degraded",
    webhookLastDeliveryAt: params.deliveredAt ?? integrations.webhookLastDeliveryAt,
    webhookFailureCount24h: params.success ? 0 : integrations.webhookFailureCount24h + 1,
  });
}

async function sendSlackWebhookMessage(workspaceId: string, text: string): Promise<string> {
  const webhookUrl = await resolveSlackWebhookUrl(workspaceId);
  if (!webhookUrl) {
    throw new Error("Slack webhook URL is not configured for this workspace.");
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`Slack webhook delivery failed with ${response.status}.${details ? ` ${details}` : ""}`.trim());
  }

  return new Date().toISOString();
}

async function sendEmailMessage(params: {
  to: string[];
  subject: string;
  text: string;
  html: string;
}): Promise<string> {
  const apiKey = getResendApiKey();
  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not configured for email delivery.");
  }

  const from = getEmailFromAddress();
  if (!from) {
    throw new Error("AGENTGIT_EMAIL_FROM is not configured for email delivery.");
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: params.to,
      subject: params.subject,
      text: params.text,
      html: params.html,
    }),
  });

  if (!response.ok) {
    const details = await response.text().catch(() => "");
    throw new Error(`Email delivery failed with ${response.status}.${details ? ` ${details}` : ""}`.trim());
  }

  return new Date().toISOString();
}

function buildApprovalRequestedText(params: {
  repositoryOwner: string;
  repositoryName: string;
  approval: ApprovalInboxItem;
}) {
  const repoLabel = `${params.repositoryOwner}/${params.repositoryName}`;
  return [
    `AgentGit approval requested for ${repoLabel}.`,
    `Workflow: ${params.approval.workflow_name}`,
    `Action: ${params.approval.action_summary}`,
    `Reason: ${params.approval.reason_summary ?? "Policy review required."}`,
    `Target: ${params.approval.target_label ?? params.approval.target_locator}`,
    `Approval ID: ${params.approval.approval_id}`,
  ].join("\n");
}

function buildApprovalRequestedHtml(params: {
  repositoryOwner: string;
  repositoryName: string;
  approval: ApprovalInboxItem;
}) {
  const reason = params.approval.reason_summary ?? "Policy review required.";
  return [
    '<div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827">',
    `<h2 style="margin-bottom:12px">Approval requested for ${params.repositoryOwner}/${params.repositoryName}</h2>`,
    `<p><strong>Workflow:</strong> ${params.approval.workflow_name}</p>`,
    `<p><strong>Action:</strong> ${params.approval.action_summary}</p>`,
    `<p><strong>Reason:</strong> ${reason}</p>`,
    `<p><strong>Target:</strong> ${params.approval.target_label ?? params.approval.target_locator}</p>`,
    `<p><strong>Approval ID:</strong> ${params.approval.approval_id}</p>`,
    "</div>",
  ].join("");
}

function buildGenericNotificationHtml(params: { heading: string; lines: Array<[label: string, value: string]> }) {
  return [
    '<div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827">',
    `<h2 style="margin-bottom:12px">${params.heading}</h2>`,
    ...params.lines.map(([label, value]) => `<p><strong>${label}:</strong> ${value}</p>`),
    "</div>",
  ].join("");
}

function notificationRiskRank(level: ApprovalInboxItem["side_effect_level"]) {
  switch (level) {
    case "read_only":
      return 0;
    case "mutating":
      return 1;
    case "destructive":
      return 2;
    default:
      return 2;
  }
}

function parseTimeToMinutes(value: string) {
  const [hours, minutes] = value.split(":").map((part) => Number.parseInt(part, 10));
  return hours * 60 + minutes;
}

function resolveBusinessHoursParts(businessHours: WorkspaceNotificationBusinessHours, now: Date) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: businessHours.timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const weekday = parts
    .find((part) => part.type === "weekday")
    ?.value.toLowerCase()
    .slice(0, 3) as NotificationBusinessDay | undefined;
  const hour = Number.parseInt(parts.find((part) => part.type === "hour")?.value ?? "0", 10);
  const minute = Number.parseInt(parts.find((part) => part.type === "minute")?.value ?? "0", 10);

  return {
    weekday: weekday ?? "mon",
    minuteOfDay: hour * 60 + minute,
  };
}

function isWithinBusinessHours(businessHours: WorkspaceNotificationBusinessHours, now = new Date()) {
  const current = resolveBusinessHoursParts(businessHours, now);
  if (!businessHours.weekdays.includes(current.weekday)) {
    return false;
  }

  const start = parseTimeToMinutes(businessHours.startTime);
  const end = parseTimeToMinutes(businessHours.endTime);
  if (start <= end) {
    return current.minuteOfDay >= start && current.minuteOfDay <= end;
  }

  return current.minuteOfDay >= start || current.minuteOfDay <= end;
}

function findNotificationRule(integrations: WorkspaceIntegrationSnapshot, event: NotificationEvent) {
  return integrations.notificationRules.find((rule) => rule.event === event) ?? buildDefaultNotificationRule(event);
}

function shouldDeliverNotificationEvent(params: {
  event: NotificationEvent;
  repositoryOwner: string;
  repositoryName: string;
  integrations: WorkspaceIntegrationSnapshot;
  approval?: ApprovalInboxItem;
  now?: Date;
}) {
  if (!params.integrations.notificationEvents.includes(params.event)) {
    return false;
  }

  const rule = findNotificationRule(params.integrations, params.event);
  const repositoryLabel = `${params.repositoryOwner}/${params.repositoryName}`;
  if (rule.repositoryScope === "selected" && !rule.repositoryTargets.includes(repositoryLabel)) {
    return false;
  }

  if (
    params.event === "approval_requested" &&
    params.approval &&
    notificationRiskRank(params.approval.side_effect_level) < notificationRiskRank(rule.minimumRiskLevel)
  ) {
    return false;
  }

  if (
    rule.deliveryWindow === "business_hours" &&
    !isWithinBusinessHours(params.integrations.notificationBusinessHours, params.now)
  ) {
    return false;
  }

  return true;
}

async function deliverWorkspaceEventNotification(params: {
  workspaceId: string;
  event: NotificationEvent;
  repositoryOwner: string;
  repositoryName: string;
  integrations: WorkspaceIntegrationSnapshot;
  subject: string;
  text: string;
  html: string;
}): Promise<NotificationDeliveryResult> {
  const result: NotificationDeliveryResult = {
    deliveredAt: null,
    failures: [],
    sent: [],
  };

  if (params.integrations.emailNotificationsEnabled) {
    try {
      const recipients = await resolveWorkspaceMemberEmails(params.workspaceId);
      if (recipients.length === 0) {
        throw new Error("Workspace has no active member emails for notification delivery.");
      }

      result.deliveredAt = await sendEmailMessage({
        to: recipients,
        subject: params.subject,
        text: params.text,
        html: params.html,
      });
      result.sent.push("email");
    } catch (error) {
      result.failures.push(error instanceof Error ? error.message : "Email delivery failed.");
    }
  }

  const shouldSendSlack =
    params.integrations.slackConnected &&
    params.integrations.slackDeliveryMode !== "disabled" &&
    (params.event === "approval_requested" || params.integrations.slackDeliveryMode === "all");

  if (shouldSendSlack) {
    try {
      result.deliveredAt = await sendSlackWebhookMessage(params.workspaceId, params.text);
      result.sent.push("slack");
    } catch (error) {
      result.failures.push(error instanceof Error ? error.message : "Slack delivery failed.");
    }
  }

  return result;
}

async function deliverApprovalRequestedNotification(params: {
  workspaceId: string;
  repositoryOwner: string;
  repositoryName: string;
  approval: ApprovalInboxItem;
  integrations: WorkspaceIntegrationSnapshot;
}): Promise<NotificationDeliveryResult> {
  const result: NotificationDeliveryResult = {
    deliveredAt: null,
    failures: [],
    sent: [],
  };

  if (
    !shouldDeliverNotificationEvent({
      event: "approval_requested",
      repositoryOwner: params.repositoryOwner,
      repositoryName: params.repositoryName,
      approval: params.approval,
      integrations: params.integrations,
    })
  ) {
    return result;
  }

  const messageText = buildApprovalRequestedText({
    repositoryOwner: params.repositoryOwner,
    repositoryName: params.repositoryName,
    approval: params.approval,
  });
  return deliverWorkspaceEventNotification({
    workspaceId: params.workspaceId,
    event: "approval_requested",
    repositoryOwner: params.repositoryOwner,
    repositoryName: params.repositoryName,
    integrations: params.integrations,
    subject: `[AgentGit] Approval required for ${params.repositoryOwner}/${params.repositoryName}`,
    text: messageText,
    html: buildApprovalRequestedHtml({
      repositoryOwner: params.repositoryOwner,
      repositoryName: params.repositoryName,
      approval: params.approval,
    }),
  });
}

export async function resolveWorkspaceIntegrations(
  workspaceSession: WorkspaceSession,
): Promise<WorkspaceIntegrationSnapshot> {
  return resolveWorkspaceIntegrationsByWorkspace({
    workspaceId: workspaceSession.activeWorkspace.id,
    workspaceSlug: workspaceSession.activeWorkspace.slug,
  });
}

export async function saveWorkspaceIntegrations(
  workspaceSession: WorkspaceSession,
  update: WorkspaceIntegrationUpdate,
): Promise<WorkspaceIntegrationSaveResponse> {
  const current = await resolveWorkspaceIntegrations(workspaceSession);
  const existingSecrets = await getWorkspaceIntegrationSecrets(workspaceSession.activeWorkspace.id);
  const { slackWebhookUrl: _slackWebhookUrl, ...publicUpdate } = update;
  const normalizedUpdate = {
    ...publicUpdate,
    notificationBusinessHours: publicUpdate.notificationBusinessHours ?? current.notificationBusinessHours,
    notificationRules: normalizeNotificationRules(publicUpdate.notificationRules),
  };
  const nextSlackWebhookUrl = !update.slackConnected
    ? null
    : (normalizeWebhookUrl(update.slackWebhookUrl) ?? existingSecrets?.slackWebhookUrl ?? null);

  await saveWorkspaceIntegrationSecrets(workspaceSession.activeWorkspace.id, {
    slackWebhookUrl: nextSlackWebhookUrl,
  });

  await saveStoredWorkspaceIntegrations(workspaceSession.activeWorkspace.id, {
    ...current,
    ...normalizedUpdate,
    slackWebhookConfigured: Boolean(nextSlackWebhookUrl ?? getSlackWebhookUrlFromEnvironment()),
    slackWorkspaceName: update.slackConnected ? update.slackWorkspaceName || current.slackWorkspaceName : undefined,
    slackChannelName: update.slackConnected ? update.slackChannelName || current.slackChannelName : undefined,
  });

  return {
    integrations: await resolveWorkspaceIntegrations(workspaceSession),
    savedAt: new Date().toISOString(),
    message: "Integrations saved.",
  };
}

export async function sendWorkspaceIntegrationTest(
  workspaceSession: WorkspaceSession,
  channel: IntegrationTestChannel,
): Promise<IntegrationTestResponse> {
  const integrations = await resolveWorkspaceIntegrations(workspaceSession);

  if (channel === "slack" && (!integrations.slackConnected || integrations.slackDeliveryMode === "disabled")) {
    throw new Error("Slack delivery is not configured for this workspace.");
  }

  if (channel === "email" && !integrations.emailNotificationsEnabled) {
    throw new Error("Email delivery is disabled for this workspace.");
  }

  const workspaceId = workspaceSession.activeWorkspace.id;
  const deliveredAt = new Date().toISOString();

  try {
    if (channel === "slack") {
      await sendSlackWebhookMessage(
        workspaceId,
        `AgentGit test notification for ${workspaceSession.activeWorkspace.name} (${integrations.slackChannelName ?? "configured channel"}).`,
      );
    } else if (channel === "email") {
      const recipients = await resolveWorkspaceMemberEmails(workspaceId);
      if (recipients.length === 0) {
        throw new Error("Workspace has no active member emails for notification delivery.");
      }

      await sendEmailMessage({
        to: recipients,
        subject: `[AgentGit] Test notification for ${workspaceSession.activeWorkspace.name}`,
        text: `AgentGit test notification for ${workspaceSession.activeWorkspace.name}.`,
        html: `<p>AgentGit test notification for <strong>${workspaceSession.activeWorkspace.name}</strong>.</p>`,
      });
    }

    await persistDeliveryStatus(workspaceId, integrations, {
      deliveredAt,
      success: true,
    });
  } catch (error) {
    await persistDeliveryStatus(workspaceId, integrations, {
      deliveredAt: null,
      success: false,
    });
    throw error;
  }

  return {
    channel,
    deliveredAt,
    message:
      channel === "slack"
        ? `Slack test delivered to ${integrations.slackChannelName ?? "the configured channel"}.`
        : channel === "email"
          ? "Email notification delivered to active workspace members."
          : "In-app notification added to the workspace activity feed.",
  };
}

export async function notifyWorkspaceApprovalRequested(params: {
  workspaceId: string;
  workspaceSlug: string;
  repositoryOwner: string;
  repositoryName: string;
  approval: ApprovalInboxItem;
}): Promise<void> {
  const integrations = await resolveWorkspaceIntegrationsByWorkspace({
    workspaceId: params.workspaceId,
    workspaceSlug: params.workspaceSlug,
  });

  const delivery = await deliverApprovalRequestedNotification({
    workspaceId: params.workspaceId,
    repositoryOwner: params.repositoryOwner,
    repositoryName: params.repositoryName,
    approval: params.approval,
    integrations,
  });

  if (delivery.sent.length === 0 && delivery.failures.length === 0) {
    return;
  }

  await persistDeliveryStatus(params.workspaceId, integrations, {
    deliveredAt: delivery.deliveredAt,
    success: delivery.failures.length === 0,
  });
}

async function notifyWorkspaceGenericEvent(params: {
  workspaceId: string;
  workspaceSlug: string;
  event: NotificationEvent;
  repositoryOwner: string;
  repositoryName: string;
  subject: string;
  text: string;
  html: string;
}) {
  const integrations = await resolveWorkspaceIntegrationsByWorkspace({
    workspaceId: params.workspaceId,
    workspaceSlug: params.workspaceSlug,
  });

  if (
    !shouldDeliverNotificationEvent({
      event: params.event,
      repositoryOwner: params.repositoryOwner,
      repositoryName: params.repositoryName,
      integrations,
    })
  ) {
    return;
  }

  const delivery = await deliverWorkspaceEventNotification({
    workspaceId: params.workspaceId,
    event: params.event,
    repositoryOwner: params.repositoryOwner,
    repositoryName: params.repositoryName,
    integrations,
    subject: params.subject,
    text: params.text,
    html: params.html,
  });

  if (delivery.sent.length === 0 && delivery.failures.length === 0) {
    return;
  }

  await persistDeliveryStatus(params.workspaceId, integrations, {
    deliveredAt: delivery.deliveredAt,
    success: delivery.failures.length === 0,
  });
}

export async function notifyWorkspaceRunFailed(params: {
  workspaceId: string;
  workspaceSlug: string;
  repositoryOwner: string;
  repositoryName: string;
  runId: string;
  actionId?: string | null;
}) {
  const heading = `Run failed for ${params.repositoryOwner}/${params.repositoryName}`;
  await notifyWorkspaceGenericEvent({
    workspaceId: params.workspaceId,
    workspaceSlug: params.workspaceSlug,
    event: "run_failed",
    repositoryOwner: params.repositoryOwner,
    repositoryName: params.repositoryName,
    subject: `[AgentGit] Run failed for ${params.repositoryOwner}/${params.repositoryName}`,
    text: [
      `AgentGit detected a governed run failure for ${params.repositoryOwner}/${params.repositoryName}.`,
      `Run ID: ${params.runId}`,
      params.actionId ? `Action ID: ${params.actionId}` : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
    html: buildGenericNotificationHtml({
      heading,
      lines: [
        ["Run ID", params.runId],
        ...(params.actionId ? ([["Action ID", params.actionId]] as Array<[string, string]>) : []),
      ],
    }),
  });
}

export async function notifyWorkspacePolicyChanged(params: {
  workspaceId: string;
  workspaceSlug: string;
  repositoryOwner: string;
  repositoryName: string;
  kind: string;
  digest?: string | null;
}) {
  const heading = `Policy changed for ${params.repositoryOwner}/${params.repositoryName}`;
  await notifyWorkspaceGenericEvent({
    workspaceId: params.workspaceId,
    workspaceSlug: params.workspaceSlug,
    event: "policy_changed",
    repositoryOwner: params.repositoryOwner,
    repositoryName: params.repositoryName,
    subject: `[AgentGit] Policy changed for ${params.repositoryOwner}/${params.repositoryName}`,
    text: [
      `AgentGit synchronized updated policy state for ${params.repositoryOwner}/${params.repositoryName}.`,
      `Policy kind: ${params.kind}`,
      params.digest ? `Digest: ${params.digest}` : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
    html: buildGenericNotificationHtml({
      heading,
      lines: [
        ["Policy kind", params.kind],
        ...(params.digest ? ([["Digest", params.digest]] as Array<[string, string]>) : []),
      ],
    }),
  });
}

export async function notifyWorkspaceSnapshotRestored(params: {
  workspaceId: string;
  workspaceSlug: string;
  repositoryOwner: string;
  repositoryName: string;
  runId: string;
  snapshotId?: string | null;
}) {
  const heading = `Snapshot restored for ${params.repositoryOwner}/${params.repositoryName}`;
  await notifyWorkspaceGenericEvent({
    workspaceId: params.workspaceId,
    workspaceSlug: params.workspaceSlug,
    event: "snapshot_restored",
    repositoryOwner: params.repositoryOwner,
    repositoryName: params.repositoryName,
    subject: `[AgentGit] Snapshot restored for ${params.repositoryOwner}/${params.repositoryName}`,
    text: [
      `AgentGit restored a snapshot for ${params.repositoryOwner}/${params.repositoryName}.`,
      `Run ID: ${params.runId}`,
      params.snapshotId ? `Snapshot ID: ${params.snapshotId}` : null,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n"),
    html: buildGenericNotificationHtml({
      heading,
      lines: [
        ["Run ID", params.runId],
        ...(params.snapshotId ? ([["Snapshot ID", params.snapshotId]] as Array<[string, string]>) : []),
      ],
    }),
  });
}
