"use client";

import { useEffect, useMemo, useState } from "react";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";

import { EmptyState, LoadingSkeleton, PageStatePanel } from "@/components/feedback";
import { MetricCard, PageHeader } from "@/components/composites";
import { Badge, Button, Card, Input, ToastCard, ToastViewport } from "@/components/primitives";
import { ApiClientError } from "@/lib/api/client";
import { sendIntegrationTest, updateWorkspaceIntegrations } from "@/lib/api/endpoints/integrations";
import { useWorkspaceIntegrationsQuery } from "@/lib/query/hooks";
import { queryKeys } from "@/lib/query/keys";
import { formatAbsoluteDate, formatNumber, formatRelativeTimestamp } from "@/lib/utils/format";
import {
  WorkspaceIntegrationUpdateSchema,
  type IntegrationHealthStatus,
  type IntegrationTestChannel,
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

type IntegrationToast = {
  title: string;
  message: string;
  tone: "success" | "warning" | "error";
};

export function IntegrationsSettingsPage() {
  const queryClient = useQueryClient();
  const integrationsQuery = useWorkspaceIntegrationsQuery();
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [toast, setToast] = useState<IntegrationToast | null>(null);

  const form = useForm<WorkspaceIntegrationUpdate>({
    resolver: zodResolver(WorkspaceIntegrationUpdateSchema),
    defaultValues: {
      slackConnected: false,
      slackWorkspaceName: "",
      slackChannelName: "",
      slackDeliveryMode: "approvals_only",
      emailNotificationsEnabled: true,
      digestCadence: "daily",
      notificationEvents: ["approval_requested", "run_failed"],
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
      slackWorkspaceName: integrationsQuery.data.slackWorkspaceName ?? "",
      slackChannelName: integrationsQuery.data.slackChannelName ?? "",
      slackDeliveryMode: integrationsQuery.data.slackDeliveryMode,
      emailNotificationsEnabled: integrationsQuery.data.emailNotificationsEnabled,
      digestCadence: integrationsQuery.data.digestCadence,
      notificationEvents: integrationsQuery.data.notificationEvents,
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

  const saveMutation = useMutation({
    mutationFn: (values: WorkspaceIntegrationUpdate) => updateWorkspaceIntegrations(values),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.integrations, result.integrations);
      reset({
        slackConnected: result.integrations.slackConnected,
        slackWorkspaceName: result.integrations.slackWorkspaceName ?? "",
        slackChannelName: result.integrations.slackChannelName ?? "",
        slackDeliveryMode: result.integrations.slackDeliveryMode,
        emailNotificationsEnabled: result.integrations.emailNotificationsEnabled,
        digestCadence: result.integrations.digestCadence,
        notificationEvents: result.integrations.notificationEvents,
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
        return;
      }

      setSubmitError("Could not save integrations. Retry.");
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

  const values = watch();
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
        actions={<Badge tone={isDirty ? "warning" : "success"}>{isDirty ? "Unsaved integration changes" : "Integration state synced"}</Badge>}
        description="Admin-only integration controls for GitHub app health, webhook delivery, and notification channels."
        title="Integrations"
      />

      <div className="grid gap-6 md:grid-cols-3">
        <MetricCard label="GitHub app" trend={integrations.githubOrgName} value={integrations.githubAppStatus} />
        <MetricCard label="Webhook failures" trend={`last delivery ${formatRelativeTimestamp(integrations.webhookLastDeliveryAt)}`} value={formatNumber(integrations.webhookFailureCount24h)} />
        <MetricCard label="Active channels" trend={`${values.notificationEvents.length} events selected`} value={formatNumber(activeChannels)} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,1fr)]">
        <form className="space-y-6" onSubmit={handleSubmit(onSubmit)}>
          <Card className="space-y-5">
            <div className="space-y-2">
              <h2 className="text-lg font-semibold">GitHub app health</h2>
              <p className="text-sm text-[var(--ag-text-secondary)]">
                This route now persists integration state durably while reconnect and provider-managed setup flows remain deferred.
              </p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold">Installation</span>
                  <Badge tone={getHealthTone(integrations.githubAppStatus)}>{integrations.githubAppStatus}</Badge>
                </div>
                <p className="mt-2 text-sm text-[var(--ag-text-secondary)]">
                  GitHub App installed for <span className="font-medium text-[var(--ag-text-primary)]">{integrations.githubOrgName}</span>.
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
                <select className={selectClassName()} disabled={!values.slackConnected} {...register("slackDeliveryMode")}>
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
                <span className="block text-sm font-semibold text-[var(--ag-text-primary)]">Enable email notifications</span>
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
                    <input checked={selected} className={checkboxClassName()} onChange={() => undefined} type="checkbox" />
                    <div className="space-y-1">
                      <div className="text-sm font-semibold text-[var(--ag-text-primary)]">{notificationEventLabels[event]}</div>
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
            <h2 className="text-lg font-semibold">Current health</h2>
            <div className="space-y-3 text-sm text-[var(--ag-text-secondary)]">
              <div className="flex items-center justify-between gap-3">
                <span>GitHub organization</span>
                <span className="font-mono text-[var(--ag-text-primary)]">{integrations.githubOrgName}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Last webhook delivery</span>
                <span className="font-mono text-[var(--ag-text-primary)]">{formatAbsoluteDate(integrations.webhookLastDeliveryAt)}</span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Slack workspace</span>
                <span className="font-mono text-[var(--ag-text-primary)]">{integrations.slackWorkspaceName ?? "Not connected"}</span>
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
              <div className="mt-3">Next queued:</div>
              <div>- replace fixture-backed dashboard and repositories with real backend contracts</div>
              <div>- remove development credentials before production launch</div>
              <div>- wire external providers once backend contracts are stable</div>
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
