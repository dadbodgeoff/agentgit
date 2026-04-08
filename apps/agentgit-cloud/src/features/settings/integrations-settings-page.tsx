"use client";

import { useEffect, useMemo, useState } from "react";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";

import { EmptyState, LoadingSkeleton, PageStatePanel } from "@/components/feedback";
import { MetricCard, PageHeader } from "@/components/composites";
import { Badge, Button, Card, Input, ToastCard, ToastViewport } from "@/components/primitives";
import { ApiClientError } from "@/lib/api/client";
import {
  dispatchConnectorCommand,
  issueConnectorBootstrapToken,
  retryConnectorCommand,
  revokeConnector,
} from "@/lib/api/endpoints/connectors";
import { sendIntegrationTest, updateWorkspaceIntegrations } from "@/lib/api/endpoints/integrations";
import { useRepositoriesQuery, useWorkspaceConnectorsQuery, useWorkspaceIntegrationsQuery } from "@/lib/query/hooks";
import { queryKeys } from "@/lib/query/keys";
import { formatAbsoluteDate, formatNumber, formatRelativeTimestamp } from "@/lib/utils/format";
import {
  type ConnectorBootstrapResponse,
  WorkspaceIntegrationUpdateSchema,
  type IntegrationHealthStatus,
  type IntegrationTestChannel,
  type NotificationRule,
  type NotificationEvent,
  type WorkspaceIntegrationUpdate,
} from "@/schemas/cloud";

function selectClassName() {
  return "ag-focus-ring h-9 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] bg-[var(--ag-bg-card)] px-3 text-[14px] text-[var(--ag-text-primary)] hover:border-[var(--ag-border-strong)] focus:border-[var(--ag-color-brand)]";
}

function checkboxClassName() {
  return "h-4 w-4 rounded border border-[var(--ag-border-default)] bg-[var(--ag-bg-card)] text-[var(--ag-color-brand)]";
}

function getHealthTone(status: IntegrationHealthStatus): "success" | "warning" | "error" {
  if (status === "healthy") {
    return "success";
  }

  if (status === "warning") {
    return "warning";
  }

  return "error";
}

const notificationEventLabels: Record<NotificationEvent, string> = {
  approval_requested: "Approval requested",
  run_failed: "Run failed",
  policy_changed: "Policy changed",
  snapshot_restored: "Snapshot restored",
};

function buildDefaultNotificationRule(event: NotificationEvent): NotificationRule {
  return {
    event,
    repositoryScope: "all",
    repositoryTargets: [],
    deliveryWindow: "anytime",
    minimumRiskLevel: "read_only",
  };
}

const defaultNotificationBusinessHours = {
  timeZone: "America/New_York",
  startTime: "09:00",
  endTime: "17:00",
  weekdays: ["mon", "tue", "wed", "thu", "fri"] as Array<"mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun">,
};

function buildDefaultNotificationRules() {
  return (Object.keys(notificationEventLabels) as NotificationEvent[]).map((event) =>
    buildDefaultNotificationRule(event),
  );
}

type IntegrationToast = {
  title: string;
  message: string;
  tone: "success" | "warning" | "error";
};

function formatCommandResultSummary(command: { type: string; result: Record<string, unknown> | null }) {
  if (!command.result) {
    return null;
  }

  if (command.type === "create_commit" && typeof command.result.commitSha === "string") {
    return `Commit ${command.result.commitSha.slice(0, 12)} created.`;
  }

  if (command.type === "push_branch" && typeof command.result.branch === "string") {
    return `Branch ${command.result.branch} pushed to ${typeof command.result.remoteName === "string" ? command.result.remoteName : "origin"}.`;
  }

  if (command.type === "open_pull_request" && typeof command.result.pullRequestUrl === "string") {
    return `PR opened: ${command.result.pullRequestUrl}`;
  }

  if (command.type === "execute_restore" && typeof command.result.snapshotId === "string") {
    return `Snapshot ${command.result.snapshotId} processed${command.result.outcome ? ` (${command.result.outcome})` : ""}.`;
  }

  return null;
}

function formatCommandDisplayState(command: { status: string; nextAttemptAt?: string | null }) {
  if (command.nextAttemptAt) {
    return "retry scheduled";
  }

  if (command.status === "acked") {
    return "running";
  }

  if (command.status === "pending") {
    return "queued";
  }

  return command.status;
}

export function IntegrationsSettingsPage() {
  const queryClient = useQueryClient();
  const integrationsQuery = useWorkspaceIntegrationsQuery();
  const connectorsQuery = useWorkspaceConnectorsQuery();
  const repositoriesQuery = useRepositoriesQuery("ready");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [toast, setToast] = useState<IntegrationToast | null>(null);
  const [bootstrapDetails, setBootstrapDetails] = useState<ConnectorBootstrapResponse | null>(null);
  const [selectedConnectorId, setSelectedConnectorId] = useState<string>("");
  const [commitMessage, setCommitMessage] = useState("chore: sync local AgentGit connector changes");
  const [pullRequestTitle, setPullRequestTitle] = useState("AgentGit governed update");

  const form = useForm<WorkspaceIntegrationUpdate>({
    resolver: zodResolver(WorkspaceIntegrationUpdateSchema),
    defaultValues: {
      slackConnected: false,
      slackWebhookUrl: "",
      slackWorkspaceName: "",
      slackChannelName: "",
      slackDeliveryMode: "approvals_only",
      emailNotificationsEnabled: true,
      digestCadence: "daily",
      notificationEvents: ["approval_requested", "run_failed"],
      notificationBusinessHours: defaultNotificationBusinessHours,
      notificationRules: buildDefaultNotificationRules(),
    },
    mode: "onBlur",
  });

  const {
    formState: { errors, isDirty, isSubmitting },
    handleSubmit,
    register,
    reset,
    setValue,
    watch,
  } = form;

  useEffect(() => {
    if (!integrationsQuery.data) {
      return;
    }

    reset({
      slackConnected: integrationsQuery.data.slackConnected,
      slackWebhookUrl: "",
      slackWorkspaceName: integrationsQuery.data.slackWorkspaceName ?? "",
      slackChannelName: integrationsQuery.data.slackChannelName ?? "",
      slackDeliveryMode: integrationsQuery.data.slackDeliveryMode,
      emailNotificationsEnabled: integrationsQuery.data.emailNotificationsEnabled,
      digestCadence: integrationsQuery.data.digestCadence,
      notificationEvents: integrationsQuery.data.notificationEvents,
      notificationBusinessHours: integrationsQuery.data.notificationBusinessHours,
      notificationRules: integrationsQuery.data.notificationRules,
    });
  }, [integrationsQuery.data, reset]);

  useEffect(() => {
    if (!toast) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setToast(null);
    }, 4000);

    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    if (!connectorsQuery.data?.items.length) {
      setSelectedConnectorId("");
      return;
    }

    if (!selectedConnectorId || !connectorsQuery.data.items.some((item) => item.id === selectedConnectorId)) {
      setSelectedConnectorId(connectorsQuery.data.items[0]!.id);
    }
  }, [connectorsQuery.data, selectedConnectorId]);

  const saveMutation = useMutation({
    mutationFn: (values: WorkspaceIntegrationUpdate) => updateWorkspaceIntegrations(values),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.integrations, result.integrations);
      reset({
        slackConnected: result.integrations.slackConnected,
        slackWebhookUrl: "",
        slackWorkspaceName: result.integrations.slackWorkspaceName ?? "",
        slackChannelName: result.integrations.slackChannelName ?? "",
        slackDeliveryMode: result.integrations.slackDeliveryMode,
        emailNotificationsEnabled: result.integrations.emailNotificationsEnabled,
        digestCadence: result.integrations.digestCadence,
        notificationEvents: result.integrations.notificationEvents,
        notificationBusinessHours: result.integrations.notificationBusinessHours,
        notificationRules: result.integrations.notificationRules,
      });
      setSubmitError(null);
      setToast({
        title: "Integrations saved",
        message: result.message,
        tone: "success",
      });
    },
    onError: (error) => {
      if (error instanceof ApiClientError) {
        const message =
          typeof error.details === "object" &&
          error.details !== null &&
          "message" in error.details &&
          typeof error.details.message === "string"
            ? error.details.message
            : "Could not save integrations. Retry.";

        setSubmitError(message);
        setToast({
          title: "Save failed",
          message,
          tone: "error",
        });
        return;
      }

      setSubmitError("Could not save integrations. Retry.");
      setToast({
        title: "Save failed",
        message: "Could not save integrations. Retry.",
        tone: "error",
      });
    },
  });

  const testMutation = useMutation({
    mutationFn: (channel: IntegrationTestChannel) => sendIntegrationTest(channel),
    onSuccess: (result) => {
      setToast({
        title: "Test sent",
        message: result.message,
        tone: "success",
      });
    },
    onError: (error) => {
      if (error instanceof ApiClientError) {
        const message =
          typeof error.details === "object" &&
          error.details !== null &&
          "message" in error.details &&
          typeof error.details.message === "string"
            ? error.details.message
            : "Could not send the test notification.";

        setToast({
          title: "Test failed",
          message,
          tone: "warning",
        });
        return;
      }

      setToast({
        title: "Test failed",
        message: "Could not send the test notification.",
        tone: "warning",
      });
    },
  });

  const bootstrapMutation = useMutation({
    mutationFn: () => issueConnectorBootstrapToken(),
    onSuccess: (result) => {
      setBootstrapDetails(result);
      setToast({
        title: "Bootstrap token ready",
        message: "Use the generated command locally to register the connector.",
        tone: "success",
      });
    },
    onError: () => {
      setToast({
        title: "Bootstrap failed",
        message: "Could not issue a connector bootstrap token.",
        tone: "warning",
      });
    },
  });

  const commandMutation = useMutation({
    mutationFn: ({
      connectorId,
      request,
    }: {
      connectorId: string;
      request:
        | { type: "refresh_repo_state"; forceFullSync?: boolean }
        | { type: "create_commit"; message: string; stageAll: boolean }
        | { type: "push_branch"; branch?: string; setUpstream?: boolean }
        | { type: "open_pull_request"; title: string; baseBranch?: string; draft?: boolean };
    }) => dispatchConnectorCommand(connectorId, request),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.connectors }).catch(() => undefined);
      setToast({
        title: "Connector command queued",
        message: result.message,
        tone: "success",
      });
    },
    onError: () => {
      setToast({
        title: "Command failed",
        message: "Could not queue the connector command.",
        tone: "warning",
      });
    },
  });

  const retryMutation = useMutation({
    mutationFn: (commandId: string) => retryConnectorCommand(commandId),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.connectors }).catch(() => undefined);
      setToast({
        title: "Command retried",
        message: result.message,
        tone: "success",
      });
    },
    onError: () => {
      setToast({
        title: "Retry failed",
        message: "Could not re-queue the connector command.",
        tone: "warning",
      });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (connectorId: string) => revokeConnector(connectorId),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.connectors }).catch(() => undefined);
      setToast({
        title: "Connector revoked",
        message: result.message,
        tone: "warning",
      });
    },
    onError: () => {
      setToast({
        title: "Revoke failed",
        message: "Could not revoke the connector.",
        tone: "warning",
      });
    },
  });

  const values = watch();
  const repositoryChoices = useMemo(
    () => (repositoriesQuery.data?.items ?? []).map((repository) => `${repository.owner}/${repository.name}`),
    [repositoriesQuery.data],
  );
  const selectedConnector = connectorsQuery.data?.items.find((item) => item.id === selectedConnectorId) ?? null;
  const activeChannels = useMemo(() => {
    let total = 1;

    if (values.emailNotificationsEnabled) {
      total += 1;
    }

    if (values.slackConnected && values.slackDeliveryMode !== "disabled") {
      total += 1;
    }

    return total;
  }, [values.emailNotificationsEnabled, values.slackConnected, values.slackDeliveryMode]);

  const notificationRuleMap = useMemo(
    () => new Map(values.notificationRules.map((rule) => [rule.event, rule] as const)),
    [values.notificationRules],
  );

  function toggleNotificationEvent(event: NotificationEvent) {
    const currentEvents = values.notificationEvents;
    const nextEvents = currentEvents.includes(event)
      ? currentEvents.filter((current) => current !== event)
      : [...currentEvents, event];

    setValue("notificationEvents", nextEvents, {
      shouldDirty: true,
      shouldTouch: true,
      shouldValidate: true,
    });
  }

  function updateNotificationRule(event: NotificationEvent, updater: (rule: NotificationRule) => NotificationRule) {
    const nextRules = (Object.keys(notificationEventLabels) as NotificationEvent[]).map((candidate) => {
      const current = notificationRuleMap.get(candidate) ?? buildDefaultNotificationRule(candidate);
      return candidate === event ? updater(current) : current;
    });

    setValue("notificationRules", nextRules, {
      shouldDirty: true,
      shouldTouch: true,
      shouldValidate: true,
    });
  }

  function toggleNotificationRuleRepository(event: NotificationEvent, repositoryLabel: string) {
    updateNotificationRule(event, (rule) => {
      const selected = rule.repositoryTargets.includes(repositoryLabel);
      return {
        ...rule,
        repositoryTargets: selected
          ? rule.repositoryTargets.filter((entry) => entry !== repositoryLabel)
          : [...rule.repositoryTargets, repositoryLabel].sort((left, right) => left.localeCompare(right)),
      };
    });
  }

  async function onSubmit(values: WorkspaceIntegrationUpdate) {
    setSubmitError(null);
    await saveMutation.mutateAsync(values);
  }

  if (integrationsQuery.isPending) {
    return (
      <>
        <PageHeader
          description="Admin-only integration controls for GitHub app health, webhook delivery, and notification channels."
          title="Integrations"
        />
        <div className="grid gap-6 md:grid-cols-3">
          <MetricCard label="GitHub app" value="--" />
          <MetricCard label="Webhook failures" value="--" />
          <MetricCard label="Active channels" value="--" />
        </div>
        <Card className="space-y-4">
          <LoadingSkeleton className="w-48" />
          <LoadingSkeleton className="w-full" lines={10} />
        </Card>
      </>
    );
  }

  if (integrationsQuery.isError) {
    return (
      <>
        <PageHeader
          description="Admin-only integration controls for GitHub app health, webhook delivery, and notification channels."
          title="Integrations"
        />
        <PageStatePanel errorMessage="Could not load integrations. Retry." state="error" />
      </>
    );
  }

  if (!integrationsQuery.data) {
    return (
      <>
        <PageHeader
          description="Admin-only integration controls for GitHub app health, webhook delivery, and notification channels."
          title="Integrations"
        />
        <EmptyState description="Integration state is not available yet." title="No integrations data" />
      </>
    );
  }

  const integrations = integrationsQuery.data;

  return (
    <>
      <PageHeader
        actions={
          <Badge tone={isDirty ? "warning" : "success"}>
            {isDirty ? "Unsaved integration changes" : "Integration state synced"}
          </Badge>
        }
        description="Admin-only integration controls for GitHub app health, webhook delivery, and notification channels."
        title="Integrations"
      />

      <div className="grid gap-6 md:grid-cols-3">
        <MetricCard label="GitHub app" trend={integrations.githubOrgName} value={integrations.githubAppStatus} />
        <MetricCard
          label="Webhook failures"
          trend={`last delivery ${formatRelativeTimestamp(integrations.webhookLastDeliveryAt)}`}
          value={formatNumber(integrations.webhookFailureCount24h)}
        />
        <MetricCard
          label="Active channels"
          trend={`${values.notificationEvents.length} events selected`}
          value={formatNumber(activeChannels)}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,1fr)]">
        <form className="space-y-6" onSubmit={handleSubmit(onSubmit)}>
          <Card className="space-y-5">
            <div className="space-y-2">
              <h2 className="text-lg font-semibold">GitHub app health</h2>
              <p className="text-sm text-[var(--ag-text-secondary)]">
                This route now persists integration state durably while reconnect and provider-managed setup flows
                remain deferred.
              </p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold">Installation</span>
                  <Badge tone={getHealthTone(integrations.githubAppStatus)}>{integrations.githubAppStatus}</Badge>
                </div>
                <p className="mt-2 text-sm text-[var(--ag-text-secondary)]">
                  GitHub App installed for{" "}
                  <span className="font-medium text-[var(--ag-text-primary)]">{integrations.githubOrgName}</span>.
                </p>
              </div>
              <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold">Webhook delivery</span>
                  <Badge tone={getHealthTone(integrations.webhookStatus)}>{integrations.webhookStatus}</Badge>
                </div>
                <p className="mt-2 text-sm text-[var(--ag-text-secondary)]">
                  Last delivery {formatAbsoluteDate(integrations.webhookLastDeliveryAt)} with{" "}
                  {formatNumber(integrations.webhookFailureCount24h)} failure(s) in the last 24 hours.
                </p>
              </div>
            </div>
          </Card>

          <Card className="space-y-5">
            <div className="space-y-2">
              <h2 className="text-lg font-semibold">Slack and email routing</h2>
              <p className="text-sm text-[var(--ag-text-secondary)]">
                Configure where workspace-level approval and run-failure notifications land first.
              </p>
            </div>

            <label className="flex items-start gap-3 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] p-4">
              <input className={checkboxClassName()} type="checkbox" {...register("slackConnected")} />
              <span className="space-y-1">
                <span className="block text-sm font-semibold text-[var(--ag-text-primary)]">Enable Slack delivery</span>
                <span className="block text-sm text-[var(--ag-text-secondary)]">
                  Routes approvals and run failures into a shared engineering channel.
                </span>
              </span>
            </label>

            <div className="grid gap-4 md:grid-cols-2">
              <Input
                disabled={!values.slackConnected}
                errorText={errors.slackWebhookUrl?.message}
                helpText={
                  integrations.slackWebhookConfigured
                    ? "Webhook secret is already configured. Paste a new URL only if you want to rotate it."
                    : "Incoming webhook URL used for approval notifications."
                }
                id="slack-webhook-url"
                label="Slack webhook URL"
                placeholder={
                  integrations.slackWebhookConfigured ? "Configured" : "https://hooks.slack.com/services/..."
                }
                type="password"
                {...register("slackWebhookUrl")}
              />
              <Input
                disabled={!values.slackConnected}
                errorText={errors.slackWorkspaceName?.message}
                helpText="Optional label for the connected Slack workspace."
                id="slack-workspace-name"
                label="Slack workspace"
                {...register("slackWorkspaceName")}
              />
              <Input
                disabled={!values.slackConnected}
                errorText={errors.slackChannelName?.message}
                helpText="Channel to receive AgentGit notifications."
                id="slack-channel-name"
                label="Slack channel"
                {...register("slackChannelName")}
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="flex w-full flex-col gap-1">
                <span className="text-[13px] font-semibold text-[var(--ag-text-primary)]">Slack delivery mode</span>
                <select
                  className={selectClassName()}
                  disabled={!values.slackConnected}
                  {...register("slackDeliveryMode")}
                >
                  <option value="all">All workspace events</option>
                  <option value="approvals_only">Approvals only</option>
                  <option value="disabled">Disabled</option>
                </select>
              </label>

              <label className="flex w-full flex-col gap-1">
                <span className="text-[13px] font-semibold text-[var(--ag-text-primary)]">Email digest cadence</span>
                <select className={selectClassName()} {...register("digestCadence")}>
                  <option value="realtime">Realtime</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                </select>
              </label>
            </div>

            <label className="flex items-start gap-3 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] p-4">
              <input className={checkboxClassName()} type="checkbox" {...register("emailNotificationsEnabled")} />
              <span className="space-y-1">
                <span className="block text-sm font-semibold text-[var(--ag-text-primary)]">
                  Enable email notifications
                </span>
                <span className="block text-sm text-[var(--ag-text-secondary)]">
                  Sends approval and failure notifications to workspace members based on the selected cadence.
                </span>
              </span>
            </label>
          </Card>

          <Card className="space-y-5">
            <div className="space-y-2">
              <h2 className="text-lg font-semibold">Notification events</h2>
              <p className="text-sm text-[var(--ag-text-secondary)]">
                Choose which workspace events should fan out to the configured channels.
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              {(Object.keys(notificationEventLabels) as NotificationEvent[]).map((event) => {
                const selected = values.notificationEvents.includes(event);

                return (
                  <button
                    className={
                      selected
                        ? "ag-focus-ring flex w-full items-start gap-3 rounded-[var(--ag-radius-md)] border border-[var(--ag-color-brand)] bg-[var(--ag-bg-elevated)] p-4 text-left"
                        : "ag-focus-ring flex w-full items-start gap-3 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-card)] p-4 text-left hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-elevated)]"
                    }
                    key={event}
                    onClick={(clickEvent) => {
                      clickEvent.preventDefault();
                      toggleNotificationEvent(event);
                    }}
                    type="button"
                  >
                    <input
                      checked={selected}
                      className={checkboxClassName()}
                      onChange={() => undefined}
                      type="checkbox"
                    />
                    <div className="space-y-1">
                      <div className="text-sm font-semibold text-[var(--ag-text-primary)]">
                        {notificationEventLabels[event]}
                      </div>
                      <div className="text-sm text-[var(--ag-text-secondary)]">
                        {event === "approval_requested"
                          ? "Escalations that require a human reviewer."
                          : event === "run_failed"
                            ? "Failures that need follow-up before the next deployment."
                            : event === "policy_changed"
                              ? "Workspace or repo policy updates."
                              : "Snapshot recovery activity for audit visibility."}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
            {errors.notificationEvents?.message ? (
              <div className="text-sm text-[var(--ag-color-error)]">{errors.notificationEvents.message}</div>
            ) : null}
          </Card>

          <Card className="space-y-5">
            <div className="space-y-2">
              <h2 className="text-lg font-semibold">Notification routing rules</h2>
              <p className="text-sm text-[var(--ag-text-secondary)]">
                Scope each event by repository, risk threshold, and delivery window without changing the underlying
                channel wiring.
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <Input
                helpText="IANA timezone used for business-hours routing."
                id="notification-business-timezone"
                label="Business-hours timezone"
                {...register("notificationBusinessHours.timeZone")}
              />
              <Input
                helpText="Local start time for gated delivery."
                id="notification-business-start"
                label="Business-hours start"
                type="time"
                {...register("notificationBusinessHours.startTime")}
              />
              <Input
                helpText="Local end time for gated delivery."
                id="notification-business-end"
                label="Business-hours end"
                type="time"
                {...register("notificationBusinessHours.endTime")}
              />
            </div>

            <div className="space-y-2">
              <div className="text-[13px] font-semibold text-[var(--ag-text-primary)]">Business days</div>
              <div className="flex flex-wrap gap-2">
                {(["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const).map((day) => {
                  const selected = values.notificationBusinessHours.weekdays.includes(day);
                  return (
                    <button
                      className={
                        selected
                          ? "ag-focus-ring rounded-full border border-[var(--ag-color-brand)] bg-[var(--ag-bg-elevated)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ag-text-primary)]"
                          : "ag-focus-ring rounded-full border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-card)] px-3 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--ag-text-secondary)] hover:border-[var(--ag-border-strong)] hover:text-[var(--ag-text-primary)]"
                      }
                      key={day}
                      onClick={(event) => {
                        event.preventDefault();
                        const nextDays = selected
                          ? values.notificationBusinessHours.weekdays.filter((entry) => entry !== day)
                          : [...values.notificationBusinessHours.weekdays, day];
                        setValue("notificationBusinessHours.weekdays", nextDays, {
                          shouldDirty: true,
                          shouldTouch: true,
                          shouldValidate: true,
                        });
                      }}
                      type="button"
                    >
                      {day}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-4">
              {values.notificationEvents.map((event) => {
                const rule = notificationRuleMap.get(event) ?? buildDefaultNotificationRule(event);

                return (
                  <div
                    className="space-y-4 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-card)] p-4"
                    key={event}
                  >
                    <div className="space-y-1">
                      <div className="text-sm font-semibold text-[var(--ag-text-primary)]">
                        {notificationEventLabels[event]}
                      </div>
                      <div className="text-sm text-[var(--ag-text-secondary)]">
                        {event === "approval_requested"
                          ? "Live today for reviewer escalations. Scope by repo, risk floor, and business hours if you only want the high-signal pages."
                          : "Stored as a workspace rule now so repo-specific routing is already configured when this delivery path fires."}
                      </div>
                    </div>

                    <div className="grid gap-4 md:grid-cols-3">
                      <label className="flex w-full flex-col gap-1">
                        <span className="text-[13px] font-semibold text-[var(--ag-text-primary)]">
                          Repository scope
                        </span>
                        <select
                          className={selectClassName()}
                          onChange={(changeEvent) =>
                            updateNotificationRule(event, (current) => ({
                              ...current,
                              repositoryScope: changeEvent.target.value as NotificationRule["repositoryScope"],
                              repositoryTargets: changeEvent.target.value === "all" ? [] : current.repositoryTargets,
                            }))
                          }
                          value={rule.repositoryScope}
                        >
                          <option value="all">All workspace repositories</option>
                          <option value="selected">Selected repositories only</option>
                        </select>
                      </label>

                      <label className="flex w-full flex-col gap-1">
                        <span className="text-[13px] font-semibold text-[var(--ag-text-primary)]">Delivery window</span>
                        <select
                          className={selectClassName()}
                          onChange={(changeEvent) =>
                            updateNotificationRule(event, (current) => ({
                              ...current,
                              deliveryWindow: changeEvent.target.value as NotificationRule["deliveryWindow"],
                            }))
                          }
                          value={rule.deliveryWindow}
                        >
                          <option value="anytime">Anytime</option>
                          <option value="business_hours">Business hours only</option>
                        </select>
                      </label>

                      <label className="flex w-full flex-col gap-1">
                        <span className="text-[13px] font-semibold text-[var(--ag-text-primary)]">Risk floor</span>
                        <select
                          className={selectClassName()}
                          disabled={event !== "approval_requested"}
                          onChange={(changeEvent) =>
                            updateNotificationRule(event, (current) => ({
                              ...current,
                              minimumRiskLevel: changeEvent.target.value as NotificationRule["minimumRiskLevel"],
                            }))
                          }
                          value={rule.minimumRiskLevel}
                        >
                          <option value="read_only">All governed actions</option>
                          <option value="mutating">Mutating and destructive</option>
                          <option value="destructive">Destructive only</option>
                        </select>
                      </label>
                    </div>

                    {rule.repositoryScope === "selected" ? (
                      <div className="space-y-2">
                        <div className="text-[13px] font-semibold text-[var(--ag-text-primary)]">
                          Repositories in scope
                        </div>
                        {repositoryChoices.length === 0 ? (
                          <div className="text-sm text-[var(--ag-text-secondary)]">
                            Connect at least one repository to create repo-scoped notification rules.
                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            {repositoryChoices.map((repositoryLabel) => {
                              const selected = rule.repositoryTargets.includes(repositoryLabel);
                              return (
                                <button
                                  className={
                                    selected
                                      ? "ag-focus-ring rounded-full border border-[var(--ag-color-brand)] bg-[var(--ag-bg-elevated)] px-3 py-1 text-sm font-medium text-[var(--ag-text-primary)]"
                                      : "ag-focus-ring rounded-full border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-card)] px-3 py-1 text-sm text-[var(--ag-text-secondary)] hover:border-[var(--ag-border-strong)] hover:text-[var(--ag-text-primary)]"
                                  }
                                  key={repositoryLabel}
                                  onClick={(clickEvent) => {
                                    clickEvent.preventDefault();
                                    toggleNotificationRuleRepository(event, repositoryLabel);
                                  }}
                                  type="button"
                                >
                                  {repositoryLabel}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </Card>

          {submitError ? (
            <div className="rounded-[var(--ag-radius-md)] border border-[color:rgb(239_68_68_/_0.25)] bg-[var(--ag-bg-error)] px-4 py-3 text-sm text-[var(--ag-color-error)]">
              {submitError}
            </div>
          ) : null}

          <Card className="sticky bottom-4 space-y-4 border-[var(--ag-color-brand)] bg-[var(--ag-bg-elevated)]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold">Save rail</h2>
                <p className="text-sm text-[var(--ag-text-secondary)]">
                  Integrations now use the same explicit-save contract as the other settings pages.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={!isDirty || isSubmitting}
                  onClick={() =>
                    reset({
                      slackConnected: integrations.slackConnected,
                      slackWorkspaceName: integrations.slackWorkspaceName ?? "",
                      slackChannelName: integrations.slackChannelName ?? "",
                      slackDeliveryMode: integrations.slackDeliveryMode,
                      emailNotificationsEnabled: integrations.emailNotificationsEnabled,
                      digestCadence: integrations.digestCadence,
                      notificationEvents: integrations.notificationEvents,
                      notificationBusinessHours: integrations.notificationBusinessHours,
                      notificationRules: integrations.notificationRules,
                    })
                  }
                  type="button"
                  variant="secondary"
                >
                  Reset changes
                </Button>
                <Button disabled={!isDirty || isSubmitting} type="submit">
                  {isSubmitting ? "Saving..." : "Save integrations"}
                </Button>
              </div>
            </div>
          </Card>
        </form>

        <div className="space-y-6">
          <Card className="space-y-4">
            <h2 className="text-lg font-semibold">Test delivery</h2>
            <p className="text-sm text-[var(--ag-text-secondary)]">
              Test delivery now validates against the saved integration state instead of a static fixture path.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={testMutation.isPending}
                onClick={() => testMutation.mutate("slack")}
                size="sm"
                variant="secondary"
              >
                Test Slack
              </Button>
              <Button
                disabled={testMutation.isPending}
                onClick={() => testMutation.mutate("email")}
                size="sm"
                variant="secondary"
              >
                Test email
              </Button>
              <Button
                disabled={testMutation.isPending}
                onClick={() => testMutation.mutate("in_app")}
                size="sm"
                variant="secondary"
              >
                Test in-app
              </Button>
            </div>
          </Card>

          <Card className="space-y-4">
            <h2 className="text-lg font-semibold">Connector sync</h2>
            <p className="text-sm text-[var(--ag-text-secondary)]">
              The cloud control plane can now bootstrap local connectors, observe repo and journal state, and queue the
              first git write-back commands.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={bootstrapMutation.isPending}
                onClick={() => bootstrapMutation.mutate()}
                size="sm"
                variant="secondary"
              >
                {bootstrapMutation.isPending ? "Generating..." : "Generate bootstrap token"}
              </Button>
              <Button
                disabled={!selectedConnector || commandMutation.isPending}
                onClick={() =>
                  selectedConnector
                    ? commandMutation.mutate({
                        connectorId: selectedConnector.id,
                        request: {
                          type: "refresh_repo_state",
                          forceFullSync: true,
                        },
                      })
                    : undefined
                }
                size="sm"
                variant="secondary"
              >
                Queue sync now
              </Button>
            </div>

            {bootstrapDetails ? (
              <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3 text-sm text-[var(--ag-text-secondary)]">
                <div className="font-semibold text-[var(--ag-text-primary)]">Bootstrap command</div>
                <div className="mt-2 break-all font-mono text-xs">{bootstrapDetails.commandHint}</div>
                <div className="mt-2">Expires {formatAbsoluteDate(bootstrapDetails.expiresAt)}</div>
              </div>
            ) : null}

            {connectorsQuery.isPending ? (
              <LoadingSkeleton className="w-full" lines={4} />
            ) : connectorsQuery.isError ? (
              <div className="rounded-[var(--ag-radius-md)] border border-[color:rgb(239_68_68_/_0.25)] bg-[var(--ag-bg-error)] px-4 py-3 text-sm text-[var(--ag-color-error)]">
                Could not load connector state. Retry.
              </div>
            ) : !connectorsQuery.data?.items.length ? (
              <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3 text-sm text-[var(--ag-text-secondary)]">
                No local connectors have registered for this workspace yet.
              </div>
            ) : (
              <div className="space-y-3">
                <div className="space-y-2">
                  {connectorsQuery.data.items.map((connector) => (
                    <button
                      className={
                        connector.id === selectedConnectorId
                          ? "ag-focus-ring flex w-full items-start justify-between gap-3 rounded-[var(--ag-radius-md)] border border-[var(--ag-color-brand)] bg-[var(--ag-bg-elevated)] p-3 text-left"
                          : "ag-focus-ring flex w-full items-start justify-between gap-3 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-card)] p-3 text-left hover:border-[var(--ag-border-strong)]"
                      }
                      key={connector.id}
                      onClick={() => setSelectedConnectorId(connector.id)}
                      type="button"
                    >
                      <div className="space-y-1">
                        <div className="text-sm font-semibold text-[var(--ag-text-primary)]">
                          {connector.machineName}
                        </div>
                        <div className="text-xs text-[var(--ag-text-secondary)]">
                          {connector.repositoryOwner}/{connector.repositoryName} on {connector.currentBranch}
                        </div>
                      </div>
                      <Badge tone={connector.daemonReachable ? "success" : "warning"}>
                        {connector.status === "revoked"
                          ? "revoked"
                          : connector.daemonReachable
                            ? "daemon reachable"
                            : "daemon offline"}
                      </Badge>
                    </button>
                  ))}
                </div>

                {selectedConnector ? (
                  <div className="space-y-3 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-[var(--ag-text-primary)]">
                          {selectedConnector.connectorName}
                        </div>
                        <div className="text-xs text-[var(--ag-text-secondary)]">
                          Last seen {formatRelativeTimestamp(selectedConnector.lastSeenAt)}
                        </div>
                        {selectedConnector.statusReason ? (
                          <div className="mt-1 text-xs text-[var(--ag-text-secondary)]">
                            {selectedConnector.statusReason}
                          </div>
                        ) : null}
                      </div>
                      <Badge tone={selectedConnector.isDirty ? "warning" : "success"}>
                        {selectedConnector.isDirty ? "dirty workspace" : "clean workspace"}
                      </Badge>
                    </div>

                    <div className="grid gap-2 text-xs text-[var(--ag-text-secondary)]">
                      <div className="flex items-center justify-between gap-3">
                        <span>Provider identity</span>
                        <span className="font-mono text-[var(--ag-text-primary)]">
                          {selectedConnector.providerIdentity.provider} / {selectedConnector.providerIdentity.status}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>Head SHA</span>
                        <span className="font-mono text-[var(--ag-text-primary)]">
                          {selectedConnector.headSha.slice(0, 12)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>Pending commands</span>
                        <span className="font-mono text-[var(--ag-text-primary)]">
                          {formatNumber(selectedConnector.pendingCommandCount)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>Leased commands</span>
                        <span className="font-mono text-[var(--ag-text-primary)]">
                          {formatNumber(selectedConnector.leasedCommandCount)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>Retryable commands</span>
                        <span className="font-mono text-[var(--ag-text-primary)]">
                          {formatNumber(selectedConnector.retryableCommandCount)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>Auto retries scheduled</span>
                        <span className="font-mono text-[var(--ag-text-primary)]">
                          {formatNumber(selectedConnector.automaticRetryCount)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>Synced events</span>
                        <span className="font-mono text-[var(--ag-text-primary)]">
                          {formatNumber(selectedConnector.eventCount)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-3">
                        <span>Last command</span>
                        <span className="font-mono text-[var(--ag-text-primary)]">
                          {selectedConnector.lastCommand
                            ? `${selectedConnector.lastCommand.type} / ${selectedConnector.lastCommand.status}`
                            : "none"}
                        </span>
                      </div>
                    </div>

                    <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-card)] px-3 py-2 text-xs text-[var(--ag-text-secondary)]">
                      <div className="flex items-center justify-between gap-3">
                        <span>Canonical repo</span>
                        <span className="font-mono text-[var(--ag-text-primary)]">
                          {selectedConnector.providerIdentity.owner}/{selectedConnector.providerIdentity.name}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-3">
                        <span>Default branch</span>
                        <span className="font-mono text-[var(--ag-text-primary)]">
                          {selectedConnector.providerIdentity.defaultBranch}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center justify-between gap-3">
                        <span>Visibility</span>
                        <span className="font-mono text-[var(--ag-text-primary)]">
                          {selectedConnector.providerIdentity.visibility}
                        </span>
                      </div>
                      {selectedConnector.providerIdentity.statusReason ? (
                        <div className="mt-2">{selectedConnector.providerIdentity.statusReason}</div>
                      ) : null}
                    </div>

                    <Input
                      helpText="Queues the first cloud-driven local git commit through the connector runtime."
                      id="connector-commit-message"
                      label="Commit message"
                      onChange={(event) => setCommitMessage(event.target.value)}
                      value={commitMessage}
                    />

                    <Input
                      helpText="Queues a provider-backed pull request on the selected connector after the branch is pushed."
                      id="connector-pr-title"
                      label="Pull request title"
                      onChange={(event) => setPullRequestTitle(event.target.value)}
                      value={pullRequestTitle}
                    />

                    <div className="flex flex-wrap gap-2">
                      <Button
                        disabled={commandMutation.isPending || commitMessage.trim().length === 0}
                        onClick={() =>
                          commandMutation.mutate({
                            connectorId: selectedConnector.id,
                            request: {
                              type: "create_commit",
                              message: commitMessage.trim(),
                              stageAll: true,
                            },
                          })
                        }
                        size="sm"
                      >
                        Queue create commit
                      </Button>
                      <Button
                        disabled={commandMutation.isPending}
                        onClick={() =>
                          commandMutation.mutate({
                            connectorId: selectedConnector.id,
                            request: {
                              type: "push_branch",
                              setUpstream: false,
                            },
                          })
                        }
                        size="sm"
                        variant="secondary"
                      >
                        Queue push branch
                      </Button>
                      <Button
                        disabled={commandMutation.isPending || pullRequestTitle.trim().length === 0}
                        onClick={() =>
                          commandMutation.mutate({
                            connectorId: selectedConnector.id,
                            request: {
                              type: "open_pull_request",
                              title: pullRequestTitle.trim(),
                            },
                          })
                        }
                        size="sm"
                        variant="secondary"
                      >
                        Queue open PR
                      </Button>
                      <Button
                        disabled={
                          retryMutation.isPending ||
                          !selectedConnector.recentCommands.some((command) => command.replayable)
                        }
                        onClick={() => {
                          const retryable = selectedConnector.recentCommands.find((command) => command.replayable);
                          if (retryable) {
                            retryMutation.mutate(retryable.commandId);
                          }
                        }}
                        size="sm"
                        variant="secondary"
                      >
                        Retry last failed command
                      </Button>
                      <Button
                        disabled={revokeMutation.isPending || selectedConnector.status === "revoked"}
                        onClick={() => revokeMutation.mutate(selectedConnector.id)}
                        size="sm"
                        variant="destructive"
                      >
                        {selectedConnector.status === "revoked" ? "Connector revoked" : "Revoke connector"}
                      </Button>
                    </div>

                    <div className="space-y-3 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-card)] p-3">
                      <div className="text-sm font-semibold text-[var(--ag-text-primary)]">Recent command history</div>
                      <div className="space-y-2">
                        {selectedConnector.recentCommands.length === 0 ? (
                          <div className="text-xs text-[var(--ag-text-secondary)]">
                            No connector commands recorded yet.
                          </div>
                        ) : (
                          selectedConnector.recentCommands.map((command) => (
                            <div
                              className="rounded-[var(--ag-radius-sm)] border border-[var(--ag-border-subtle)] px-3 py-2"
                              key={command.commandId}
                            >
                              <div className="flex items-center justify-between gap-3 text-xs">
                                <span className="font-medium text-[var(--ag-text-primary)]">
                                  {command.type} / {formatCommandDisplayState(command)}
                                </span>
                                <span className="font-mono text-[var(--ag-text-secondary)]">
                                  attempt {formatNumber(command.attemptCount)}
                                </span>
                              </div>
                              <div className="mt-1 text-xs text-[var(--ag-text-secondary)]">
                                Updated {formatRelativeTimestamp(command.updatedAt)}
                                {command.leaseExpiresAt
                                  ? ` · lease expires ${formatAbsoluteDate(command.leaseExpiresAt)}`
                                  : ""}
                                {command.nextAttemptAt
                                  ? ` · retry at ${formatAbsoluteDate(command.nextAttemptAt)}`
                                  : ""}
                              </div>
                              {command.message ? (
                                <div className="mt-1 text-xs text-[var(--ag-text-secondary)]">{command.message}</div>
                              ) : null}
                              {formatCommandResultSummary(command) ? (
                                <div className="mt-1 text-xs text-[var(--ag-text-secondary)]">
                                  {formatCommandResultSummary(command)}
                                </div>
                              ) : null}
                              <div className="mt-2 flex flex-wrap gap-3 text-xs">
                                {command.detailPath ? (
                                  <a
                                    className="font-medium text-[var(--ag-color-brand)] underline-offset-4 hover:underline"
                                    href={command.detailPath}
                                  >
                                    Open context
                                  </a>
                                ) : null}
                                {command.externalUrl ? (
                                  <a
                                    className="font-medium text-[var(--ag-color-brand)] underline-offset-4 hover:underline"
                                    href={command.externalUrl}
                                    rel="noreferrer"
                                    target="_blank"
                                  >
                                    Open provider
                                  </a>
                                ) : null}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    </div>

                    <div className="space-y-3 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-card)] p-3">
                      <div className="text-sm font-semibold text-[var(--ag-text-primary)]">Recent synced events</div>
                      <div className="space-y-2">
                        {selectedConnector.recentEvents.length === 0 ? (
                          <div className="text-xs text-[var(--ag-text-secondary)]">
                            No connector events have synced yet.
                          </div>
                        ) : (
                          selectedConnector.recentEvents.map((event) => (
                            <div
                              className="flex items-center justify-between gap-3 rounded-[var(--ag-radius-sm)] border border-[var(--ag-border-subtle)] px-3 py-2 text-xs"
                              key={event.eventId}
                            >
                              <span className="font-medium text-[var(--ag-text-primary)]">{event.type}</span>
                              <span className="text-[var(--ag-text-secondary)]">
                                {formatRelativeTimestamp(event.occurredAt)}
                              </span>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </Card>

          <Card className="space-y-4">
            <h2 className="text-lg font-semibold">Current health</h2>
            <div className="space-y-3 text-sm text-[var(--ag-text-secondary)]">
              <div className="flex items-center justify-between gap-3">
                <span>GitHub organization</span>
                <span className="font-mono text-[var(--ag-text-primary)]">{integrations.githubOrgName}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Last webhook delivery</span>
                <span className="font-mono text-[var(--ag-text-primary)]">
                  {formatAbsoluteDate(integrations.webhookLastDeliveryAt)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Slack workspace</span>
                <span className="font-mono text-[var(--ag-text-primary)]">
                  {integrations.slackWorkspaceName ?? "Not connected"}
                </span>
              </div>
            </div>
          </Card>

          <Card className="space-y-4">
            <h2 className="text-lg font-semibold">Build loop backlog</h2>
            <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3 font-mono text-xs text-[var(--ag-text-secondary)]">
              <div>Closed in this pass:</div>
              <div>- admin-only integrations settings route</div>
              <div>- protected GitHub app and notification config API</div>
              <div>- test notification success/error mutation states</div>
              <div>- connector bootstrap tokens and workspace connector inventory</div>
              <div>- command queue plus acknowledgements for local connector execution</div>
              <div>- first local git commit and push write-back command path</div>
              <div>- provider-backed GitHub pull request queueing through the connector</div>
              <div>- operator retry and revoke controls for connector fleet management</div>
              <div>- recent command and event diagnostics per registered connector</div>
              <div className="mt-3">Next queued:</div>
              <div>- replace remaining placeholder activity, audit, and action-detail surfaces</div>
              <div>- authority-backed live updates for approvals, dashboard, calibration, and operator views</div>
            </div>
          </Card>
        </div>
      </div>

      {toast ? (
        <ToastViewport>
          <ToastCard
            className={
              toast.tone === "success"
                ? "border-[color:rgb(34_197_94_/_0.28)]"
                : toast.tone === "warning"
                  ? "border-[color:rgb(245_158_11_/_0.28)]"
                  : "border-[color:rgb(239_68_68_/_0.28)]"
            }
          >
            <div className="space-y-1">
              <div className="text-sm font-semibold text-[var(--ag-text-primary)]">{toast.title}</div>
              <p className="text-sm text-[var(--ag-text-secondary)]">{toast.message}</p>
            </div>
          </ToastCard>
        </ToastViewport>
      ) : null}
    </>
  );
}
