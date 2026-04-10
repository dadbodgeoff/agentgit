"use client";

import { useEffect, useState } from "react";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";

import { EmptyState, LoadingSkeleton, PageStatePanel } from "@/components/feedback";
import { MetricCard, PageHeader } from "@/components/composites";
import { Badge, Button, Card, Input, ToastCard, ToastViewport } from "@/components/primitives";
import { ApiClientError } from "@/lib/api/client";
import { updateWorkspaceSettings } from "@/lib/api/endpoints/settings";
import { useWorkspaceSettingsQuery } from "@/lib/query/hooks";
import { queryKeys } from "@/lib/query/keys";
import { WorkspaceSettingsUpdateSchema, type WorkspaceSettingsUpdate } from "@/schemas/cloud";

function checkboxClassName() {
  return "h-4 w-4 rounded border border-[var(--ag-border-default)] bg-[var(--ag-bg-card)] text-[var(--ag-color-brand)]";
}

function selectClassName() {
  return "ag-focus-ring h-9 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] bg-[var(--ag-bg-card)] px-3 text-[14px] text-[var(--ag-text-primary)] hover:border-[var(--ag-border-strong)] focus:border-[var(--ag-color-brand)]";
}

export function WorkspaceSettingsPage() {
  const queryClient = useQueryClient();
  const settingsQuery = useWorkspaceSettingsQuery();
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [errorToast, setErrorToast] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm<WorkspaceSettingsUpdate>({
    resolver: zodResolver(WorkspaceSettingsUpdateSchema),
    defaultValues: {
      workspaceName: "",
      workspaceSlug: "",
      defaultNotificationChannel: "in_app",
      approvalTtlMinutes: 30,
      requireRejectComment: false,
      freezeDeploysOutsideBusinessHours: false,
      enterpriseSso: {
        enabled: false,
        providerType: "oidc",
        providerLabel: "Enterprise SSO",
        issuerUrl: "https://idp.example.com/realms/agentgit",
        clientId: "agentgit-cloud",
        clientSecret: "",
        emailDomains: [],
        autoProvisionMembers: true,
        defaultRole: "member",
      },
    },
    mode: "onBlur",
  });

  const {
    formState: { errors, isDirty, isSubmitting },
    handleSubmit,
    register,
    reset,
    setError,
    setValue,
    watch,
  } = form;

  useEffect(() => {
    if (settingsQuery.data) {
      reset({
        ...settingsQuery.data,
        enterpriseSso: {
          ...settingsQuery.data.enterpriseSso,
          clientSecret: "",
        },
      });
    }
  }, [reset, settingsQuery.data]);

  useEffect(() => {
    if (!toastMessage) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setToastMessage(null);
    }, 4000);

    return () => window.clearTimeout(timeout);
  }, [toastMessage]);

  useEffect(() => {
    if (!errorToast) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setErrorToast(null);
    }, 4000);

    return () => window.clearTimeout(timeout);
  }, [errorToast]);

  const saveMutation = useMutation({
    mutationFn: (values: WorkspaceSettingsUpdate) => updateWorkspaceSettings(values),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.workspaceSettings, result.settings);
      reset(result.settings);
      setSubmitError(null);
      setToastMessage(result.message);
    },
    onError: (error) => {
      if (error instanceof ApiClientError) {
        const field =
          typeof error.details === "object" &&
          error.details !== null &&
          "field" in error.details &&
          error.details.field === "enterpriseSso.issuerUrl"
            ? "enterpriseSso.issuerUrl"
            : null;
        const message =
          typeof error.details === "object" &&
          error.details !== null &&
          "message" in error.details &&
          typeof error.details.message === "string"
            ? error.details.message
            : "Could not save settings. Try again.";

        if (field) {
          setError(field, {
            type: "server",
            message,
          });
        }

        setSubmitError(message);
        setErrorToast(message);
        return;
      }

      setSubmitError("Could not save settings. Try again.");
      setErrorToast("Could not save settings. Try again.");
    },
  });

  const values = watch();

  async function onSubmit(values: WorkspaceSettingsUpdate) {
    setSubmitError(null);
    await saveMutation.mutateAsync(values);
  }

  if (settingsQuery.isPending) {
    return (
      <>
        <PageHeader
          description="Workspace settings with explicit save, dirty tracking, and validated form wiring."
          title="Workspace settings"
        />
        <div className="grid gap-6 md:grid-cols-3">
          <MetricCard label="Notification channel" value="--" />
          <MetricCard label="Approval TTL" value="--" />
          <MetricCard label="Dirty state" value="--" />
        </div>
        <Card className="space-y-4">
          <LoadingSkeleton className="w-48" />
          <LoadingSkeleton className="w-full" lines={8} />
        </Card>
      </>
    );
  }

  if (settingsQuery.isError) {
    return (
      <>
        <PageHeader
          description="Workspace settings with explicit save, dirty tracking, and validated form wiring."
          title="Workspace settings"
        />
        <PageStatePanel errorMessage="Could not load workspace settings. Retry." state="error" />
      </>
    );
  }

  if (!settingsQuery.data) {
    return (
      <>
        <PageHeader
          description="Workspace settings with explicit save, dirty tracking, and validated form wiring."
          title="Workspace settings"
        />
        <EmptyState
          description="Settings have not been initialized for this workspace yet."
          title="No settings available"
        />
      </>
    );
  }

  return (
    <>
      <PageHeader
        actions={
          <Badge tone={isDirty ? "warning" : "success"}>{isDirty ? "Unsaved changes" : "All changes saved"}</Badge>
        }
        description="Workspace settings with explicit save, dirty tracking, and validated form wiring."
        title="Workspace settings"
      />

      <div className="grid gap-6 md:grid-cols-3">
        <MetricCard label="Notification channel" value={values.defaultNotificationChannel.replace("_", " ")} />
        <MetricCard label="Approval TTL" trend="policy default" value={`${values.approvalTtlMinutes}m`} />
        <MetricCard
          label="Enterprise SSO"
          trend={values.enterpriseSso.enabled ? values.enterpriseSso.providerLabel : "disabled"}
          value={values.enterpriseSso.enabled ? values.enterpriseSso.defaultRole : "Off"}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,1fr)]">
        <form className="space-y-6" onSubmit={handleSubmit(onSubmit)}>
          <Card className="space-y-5">
            <div className="space-y-2">
              <h2 className="text-lg font-semibold">Workspace profile</h2>
              <p className="text-sm text-[var(--ag-text-secondary)]">
                Update the hosted workspace identity, approval defaults, and enterprise SSO contract from one place.
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <Input
                errorText={errors.workspaceName?.message}
                helpText="Shown in the sidebar, command palette, and notifications."
                label="Workspace name"
                {...register("workspaceName")}
              />
              <Input
                errorText={errors.workspaceSlug?.message}
                helpText="Lowercase letters, numbers, and hyphens only."
                label="Workspace slug"
                {...register("workspaceSlug")}
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="flex w-full flex-col gap-1">
                <span className="text-[13px] font-semibold text-[var(--ag-text-primary)]">
                  Default notification channel
                </span>
                <select className={selectClassName()} {...register("defaultNotificationChannel")}>
                  <option value="in_app">In-app</option>
                  <option value="email">Email</option>
                  <option value="slack">Slack</option>
                </select>
                <span className="text-[12px] text-[var(--ag-text-secondary)]">
                  Where approval and run-status notifications go first.
                </span>
              </label>

              <Input
                errorText={errors.approvalTtlMinutes?.message}
                helpText="Allowed range: 15 to 120 minutes."
                label="Approval timeout (minutes)"
                type="number"
                {...register("approvalTtlMinutes", { valueAsNumber: true })}
              />
            </div>
          </Card>

          <Card className="space-y-5">
            <div className="space-y-2">
              <h2 className="text-lg font-semibold">Review policy defaults</h2>
              <p className="text-sm text-[var(--ag-text-secondary)]">
                Save-required toggles stay local until the reviewer confirms the full change set.
              </p>
            </div>

            <label className="flex items-start gap-3 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] p-4">
              <input className={checkboxClassName()} type="checkbox" {...register("requireRejectComment")} />
              <span className="space-y-1">
                <span className="block text-sm font-semibold text-[var(--ag-text-primary)]">
                  Require a reject comment
                </span>
                <span className="block text-sm text-[var(--ag-text-secondary)]">
                  Adds more context to the audit trail when a reviewer blocks an action.
                </span>
              </span>
            </label>

            <label className="flex items-start gap-3 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] p-4">
              <input
                className={checkboxClassName()}
                type="checkbox"
                {...register("freezeDeploysOutsideBusinessHours")}
              />
              <span className="space-y-1">
                <span className="block text-sm font-semibold text-[var(--ag-text-primary)]">
                  Freeze deploys outside business hours
                </span>
                <span className="block text-sm text-[var(--ag-text-secondary)]">
                  Keeps production deploy requests in the queue until a workspace reviewer approves them during the day.
                </span>
              </span>
            </label>
          </Card>

          <Card className="space-y-5">
            <div className="space-y-2">
              <h2 className="text-lg font-semibold">Enterprise SSO</h2>
              <p className="text-sm text-[var(--ag-text-secondary)]">
                Configure a workspace-owned OIDC identity provider for Okta or Azure AD. The client secret is write-only
                and is never echoed back to the browser.
              </p>
            </div>

            <label className="flex items-start gap-3 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] p-4">
              <input className={checkboxClassName()} type="checkbox" {...register("enterpriseSso.enabled")} />
              <span className="space-y-1">
                <span className="block text-sm font-semibold text-[var(--ag-text-primary)]">Enable enterprise SSO</span>
                <span className="block text-sm text-[var(--ag-text-secondary)]">
                  When enabled, members can sign in through the workspace IdP instead of GitHub.
                </span>
              </span>
            </label>

            <div className="grid gap-4 md:grid-cols-2">
              <Input
                errorText={errors.enterpriseSso?.providerLabel?.message}
                helpText="Shown on the hosted sign-in screen."
                label="Provider label"
                {...register("enterpriseSso.providerLabel")}
              />
              <Input
                errorText={errors.enterpriseSso?.issuerUrl?.message}
                helpText="OIDC issuer URL for Okta, Azure AD, or another enterprise IdP."
                label="Issuer URL"
                {...register("enterpriseSso.issuerUrl")}
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <Input
                errorText={errors.enterpriseSso?.clientId?.message}
                helpText="OIDC client id issued to the AgentGit Cloud app."
                label="Client ID"
                {...register("enterpriseSso.clientId")}
              />
              <Input
                errorText={errors.enterpriseSso?.clientSecret?.message}
                helpText={
                  settingsQuery.data.enterpriseSso.clientSecretConfigured
                    ? "Leave blank to keep the existing secret."
                    : "Required before enterprise SSO can complete login."
                }
                label="Client secret"
                type="password"
                {...register("enterpriseSso.clientSecret")}
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <Input
                helpText="Comma-separated domains that are allowed to auto-join this workspace through the IdP."
                label="Allowed email domains"
                onChange={(event) => {
                  const parsed = event.target.value
                    .split(",")
                    .map((value) => value.trim().toLowerCase())
                    .filter((value) => value.length > 0);
                  setValue("enterpriseSso.emailDomains", parsed, { shouldDirty: true });
                }}
                value={watch("enterpriseSso.emailDomains").join(", ")}
              />
              <label className="flex w-full flex-col gap-1">
                <span className="text-[13px] font-semibold text-[var(--ag-text-primary)]">Default SSO role</span>
                <select className={selectClassName()} {...register("enterpriseSso.defaultRole")}>
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
                <span className="text-[12px] text-[var(--ag-text-secondary)]">
                  Applied when an IdP-authenticated user is auto-provisioned into the workspace.
                </span>
              </label>
            </div>

            <label className="flex items-start gap-3 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] p-4">
              <input
                className={checkboxClassName()}
                type="checkbox"
                {...register("enterpriseSso.autoProvisionMembers")}
              />
              <span className="space-y-1">
                <span className="block text-sm font-semibold text-[var(--ag-text-primary)]">
                  Auto-provision matching users
                </span>
                <span className="block text-sm text-[var(--ag-text-secondary)]">
                  If enabled, users from the allowed email domains join this workspace automatically after successful
                  IdP login.
                </span>
              </span>
            </label>

            <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3 text-sm text-[var(--ag-text-secondary)]">
              Enterprise sign-in provider id: <span className="font-mono">enterprise-{values.workspaceSlug}</span>
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
                  Explicit save is now validated in-app with dirty tracking and schema enforcement.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={!isDirty || isSubmitting}
                  onClick={() => reset(settingsQuery.data)}
                  type="button"
                  variant="secondary"
                >
                  Reset changes
                </Button>
                <Button disabled={!isDirty || isSubmitting} type="submit">
                  {isSubmitting ? "Saving..." : "Save settings"}
                </Button>
              </div>
            </div>
          </Card>
        </form>

        <div className="space-y-6">
          <Card className="space-y-4">
            <h2 className="text-lg font-semibold">Validated patterns</h2>
            <div className="space-y-3 text-sm text-[var(--ag-text-secondary)]">
              <p>
                Role gating now protects settings, billing, onboarding, and calibration before those routes become real.
              </p>
              <p>
                Error boundaries exist at the root app and authenticated shell levels so a crashing route does not drop
                the full session.
              </p>
              <p>
                This page validates the React Hook Form and Zod resolver path before more complex onboarding and policy
                forms land.
              </p>
            </div>
          </Card>

          <Card className="space-y-4">
            <h2 className="text-lg font-semibold">Settings operating notes</h2>
            <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3 font-mono text-xs text-[var(--ag-text-secondary)]">
              <div>Use this page to keep workspace-wide defaults aligned:</div>
              <div>- workspace identity used across the shell and notifications</div>
              <div>- approval TTL used by governed review flows</div>
              <div>- enterprise SSO issuer, allowlist, and default-role policy</div>
              <div>- notification channel defaults shared with onboarding and repository connection</div>
            </div>
          </Card>
        </div>
      </div>

      {toastMessage ? (
        <ToastViewport>
          <ToastCard className="border-[color:rgb(34_197_94_/_0.28)]">
            <div className="space-y-1">
              <div className="text-sm font-semibold text-[var(--ag-text-primary)]">Settings saved</div>
              <p className="text-sm text-[var(--ag-text-secondary)]">{toastMessage}</p>
            </div>
          </ToastCard>
        </ToastViewport>
      ) : null}
      {errorToast ? (
        <ToastViewport>
          <ToastCard className="border-[color:rgb(239_68_68_/_0.28)]">
            <div className="space-y-1">
              <div className="text-sm font-semibold text-[var(--ag-text-primary)]">Save failed</div>
              <p className="text-sm text-[var(--ag-text-secondary)]">{errorToast}</p>
            </div>
          </ToastCard>
        </ToastViewport>
      ) : null}
    </>
  );
}
