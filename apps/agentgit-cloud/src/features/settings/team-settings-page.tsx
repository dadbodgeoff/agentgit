"use client";

import { useEffect, useMemo, useState } from "react";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFieldArray, useForm } from "react-hook-form";

import { EmptyState, LoadingSkeleton, PageStatePanel } from "@/components/feedback";
import { MetricCard, PageHeader } from "@/components/composites";
import { Badge, Button, Card, Input, ToastCard, ToastViewport } from "@/components/primitives";
import { ApiClientError } from "@/lib/api/client";
import { updateWorkspaceTeam } from "@/lib/api/endpoints/team";
import { queryKeys } from "@/lib/query/keys";
import { useWorkspaceTeamQuery } from "@/lib/query/hooks";
import { WorkspaceTeamUpdateSchema, type WorkspaceTeamSnapshot, type WorkspaceTeamUpdate } from "@/schemas/cloud";

function selectClassName() {
  return "ag-focus-ring h-9 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] bg-[var(--ag-bg-card)] px-3 text-[14px] text-[var(--ag-text-primary)] hover:border-[var(--ag-border-strong)] focus:border-[var(--ag-color-brand)]";
}

function extractInvites(team: WorkspaceTeamSnapshot) {
  return team.members
    .filter((member) => member.status === "invited")
    .map((member) => ({
      name: member.name,
      email: member.email,
      role: member.role,
    }));
}

export function TeamSettingsPage() {
  const queryClient = useQueryClient();
  const teamQuery = useWorkspaceTeamQuery();
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [errorToast, setErrorToast] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm<WorkspaceTeamUpdate>({
    resolver: zodResolver(WorkspaceTeamUpdateSchema),
    defaultValues: {
      invites: [],
    },
    mode: "onBlur",
  });

  const {
    control,
    formState: { errors, isDirty, isSubmitting },
    handleSubmit,
    register,
    reset,
    watch,
  } = form;

  const inviteFieldArray = useFieldArray({
    control,
    name: "invites",
  });

  useEffect(() => {
    if (!teamQuery.data) {
      return;
    }

    reset({
      invites: extractInvites(teamQuery.data),
    });
  }, [reset, teamQuery.data]);

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

  const activeMembers = useMemo(
    () => teamQuery.data?.members.filter((member) => member.status === "active") ?? [],
    [teamQuery.data],
  );
  const invites = watch("invites");

  const saveMutation = useMutation({
    mutationFn: (values: WorkspaceTeamUpdate) => updateWorkspaceTeam(values),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.workspaceTeam, result.team);
      reset({ invites: extractInvites(result.team) });
      setSubmitError(null);
      setToastMessage(result.message);
    },
    onError: (error) => {
      if (error instanceof ApiClientError) {
        const message =
          typeof error.details === "object" &&
          error.details !== null &&
          "message" in error.details &&
          typeof error.details.message === "string"
            ? error.details.message
            : "Could not save team settings. Try again.";

        setSubmitError(message);
        setErrorToast(message);
        return;
      }

      setSubmitError("Could not save team settings. Try again.");
      setErrorToast("Could not save team settings. Try again.");
    },
  });

  async function onSubmit(values: WorkspaceTeamUpdate) {
    setSubmitError(null);
    await saveMutation.mutateAsync(values);
  }

  if (teamQuery.isPending) {
    return (
      <>
        <PageHeader description="Admin-managed roster and invite state backed by workspace persistence." title="Team" />
        <div className="grid gap-6 md:grid-cols-3">
          <MetricCard label="Active members" value="--" />
          <MetricCard label="Pending invites" value="--" />
          <MetricCard label="Invite capacity" value="--" />
        </div>
        <Card className="space-y-4">
          <LoadingSkeleton className="w-48" />
          <LoadingSkeleton className="w-full" lines={8} />
        </Card>
      </>
    );
  }

  if (teamQuery.isError) {
    return (
      <>
        <PageHeader description="Admin-managed roster and invite state backed by workspace persistence." title="Team" />
        <PageStatePanel errorMessage="Could not load team settings. Retry." state="error" />
      </>
    );
  }

  if (!teamQuery.data) {
    return (
      <>
        <PageHeader description="Admin-managed roster and invite state backed by workspace persistence." title="Team" />
        <EmptyState description="Team state has not been initialized for this workspace yet." title="No team data" />
      </>
    );
  }

  return (
    <>
      <PageHeader
        actions={<Badge tone={isDirty ? "warning" : "success"}>{isDirty ? "Unsaved changes" : "Roster saved"}</Badge>}
        description="Admin-managed roster and invite state backed by workspace persistence."
        title="Team"
      />

      <div className="grid gap-6 md:grid-cols-3">
        <MetricCard label="Active members" value={String(activeMembers.length)} />
        <MetricCard
          label="Pending invites"
          trend={`${teamQuery.data.inviteLimit} seat limit`}
          value={String(invites.length)}
        />
        <MetricCard
          label="Invite capacity"
          value={`${Math.max(teamQuery.data.inviteLimit - invites.length, 0)} left`}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(320px,1fr)]">
        <form className="space-y-6" onSubmit={handleSubmit(onSubmit)}>
          <Card className="space-y-5">
            <div className="space-y-2">
              <h2 className="text-lg font-semibold">Current workspace access</h2>
              <p className="text-sm text-[var(--ag-text-secondary)]">
                Active members are resolved from the authenticated session and current workspace role.
              </p>
            </div>

            <div className="space-y-3">
              {activeMembers.map((member) => (
                <div
                  className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] p-4"
                  key={member.id}
                >
                  <div className="space-y-1">
                    <div className="text-sm font-semibold text-[var(--ag-text-primary)]">{member.name}</div>
                    <div className="text-sm text-[var(--ag-text-secondary)]">{member.email}</div>
                  </div>
                  <Badge>{member.role}</Badge>
                </div>
              ))}
            </div>
          </Card>

          <Card className="space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-2">
                <h2 className="text-lg font-semibold">Pending invites</h2>
                <p className="text-sm text-[var(--ag-text-secondary)]">
                  Invite teammates by email and stage role changes before saving the roster.
                </p>
              </div>
              <Button
                disabled={inviteFieldArray.fields.length >= teamQuery.data.inviteLimit}
                onClick={() =>
                  inviteFieldArray.append({
                    name: "",
                    email: "",
                    role: "member",
                  })
                }
                size="sm"
                type="button"
                variant="secondary"
              >
                Add invite
              </Button>
            </div>

            {inviteFieldArray.fields.length === 0 ? (
              <EmptyState
                description="No pending invites are staged for this workspace right now."
                title="Invite list is empty"
              />
            ) : (
              <div className="space-y-4">
                {inviteFieldArray.fields.map((field, index) => (
                  <div
                    className="space-y-4 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] p-4"
                    key={field.id}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-sm font-semibold text-[var(--ag-text-primary)]">Invite {index + 1}</div>
                      <Button onClick={() => inviteFieldArray.remove(index)} size="sm" type="button" variant="ghost">
                        Remove
                      </Button>
                    </div>
                    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_160px]">
                      <Input
                        errorText={errors.invites?.[index]?.name?.message}
                        label="Name"
                        {...register(`invites.${index}.name`)}
                      />
                      <Input
                        errorText={errors.invites?.[index]?.email?.message}
                        label="Email"
                        type="email"
                        {...register(`invites.${index}.email`)}
                      />
                      <label className="flex flex-col gap-1">
                        <span className="text-[13px] font-semibold text-[var(--ag-text-primary)]">Role</span>
                        <select className={selectClassName()} {...register(`invites.${index}.role`)}>
                          <option value="member">Member</option>
                          <option value="admin">Admin</option>
                          <option value="owner">Owner</option>
                        </select>
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {submitError ? (
            <div className="rounded-[var(--ag-radius-md)] border border-[color:rgb(239_68_68_/_0.25)] bg-[var(--ag-bg-error)] px-4 py-3 text-sm text-[var(--ag-color-error)]">
              {submitError}
            </div>
          ) : null}

          <Card className="sticky bottom-4 space-y-4 border-[var(--ag-color-brand)] bg-[var(--ag-bg-elevated)]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold">Save roster</h2>
                <p className="text-sm text-[var(--ag-text-secondary)]">
                  Invite changes update the durable workspace roster that drives hosted access and approval routing.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={!isDirty || isSubmitting}
                  onClick={() => reset({ invites: extractInvites(teamQuery.data) })}
                  type="button"
                  variant="secondary"
                >
                  Reset changes
                </Button>
                <Button disabled={!isDirty || isSubmitting} type="submit">
                  {isSubmitting ? "Saving..." : "Save roster"}
                </Button>
              </div>
            </div>
          </Card>
        </form>

        <div className="space-y-6">
          <Card className="space-y-4">
            <h2 className="text-lg font-semibold">Roster guidance</h2>
            <div className="space-y-3 text-sm text-[var(--ag-text-secondary)]">
              <p>
                Workspace admins control the live roster for hosted access, notifications, and approval coverage here.
              </p>
              <p>
                Invite editing reuses the onboarding invite schema so team management cannot drift from launch-time
                rules.
              </p>
              <p>
                The roster view separates active session-derived access from pending invites staged in durable workspace
                state.
              </p>
            </div>
          </Card>
        </div>
      </div>

      {toastMessage ? (
        <ToastViewport>
          <ToastCard className="border-[color:rgb(34_197_94_/_0.28)]">
            <div className="space-y-1">
              <div className="text-sm font-semibold text-[var(--ag-text-primary)]">Team saved</div>
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
