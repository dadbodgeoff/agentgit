"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useFieldArray, useForm } from "react-hook-form";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";

import { EmptyState, LoadingSkeleton, PageStatePanel } from "@/components/feedback";
import { MetricCard, PageHeader } from "@/components/composites";
import { Badge, Button, Card, Input, Select, Stepper } from "@/components/primitives";
import { useToast } from "@/components/providers/toast-provider";
import { WorkspaceSetupChecklist } from "@/features/shared/workspace-setup-checklist";
import { ApiClientError } from "@/lib/api/client";
import { launchOnboarding } from "@/lib/api/endpoints/onboarding";
import { useWorkspace } from "@/lib/auth/workspace-context";
import { authenticatedRoutes } from "@/lib/navigation/routes";
import { useOnboardingBootstrapQuery } from "@/lib/query/hooks";
import { queryKeys } from "@/lib/query/keys";
import type { PreviewState } from "@/schemas/cloud";
import { OnboardingFormValuesSchema, type OnboardingFormValues, type PolicyPack } from "@/schemas/cloud";

const onboardingSteps = [
  { id: "workspace", title: "Workspace", description: "Create the workspace name and slug." },
  { id: "repositories", title: "Repositories", description: "Connect repositories for the first governed loop." },
  { id: "team", title: "Team", description: "Invite teammates and assign starter roles." },
  { id: "policy", title: "Policy", description: "Choose the default policy pack and notification path." },
  { id: "review", title: "Review", description: "Confirm and launch the workspace." },
] as const;

const stepFieldMap: Array<Array<keyof OnboardingFormValues>> = [
  ["workspaceName", "workspaceSlug"],
  ["repositoryIds"],
  ["invites"],
  ["defaultNotificationChannel", "policyPack"],
  ["confirmLaunch"],
];

const policyPackDescriptions: Record<PolicyPack, string> = {
  balanced: "Moves quickly for low-risk code changes while still surfacing meaningful approvals.",
  guarded: "Recommended. Requires more approvals around shell, deploy, and policy changes.",
  strict: "Max review coverage for regulated or highly sensitive repositories.",
};

function checkboxClassName() {
  return "h-4 w-4 rounded border border-[var(--ag-border-default)] bg-[var(--ag-bg-card)] text-[var(--ag-color-brand)]";
}

function OnboardingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-6 md:grid-cols-3">
        <MetricCard label="Owner access" value="--" />
        <MetricCard label="Repositories" value="--" />
        <MetricCard label="Launch state" value="--" />
      </div>
      <Card className="space-y-6">
        <LoadingSkeleton className="w-full" lines={3} />
        <LoadingSkeleton className="w-full" lines={10} />
      </Card>
    </div>
  );
}

export function OnboardingPage({ previewState = "ready" }: { previewState?: PreviewState }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [isRedirecting, startTransition] = useTransition();
  const { user, activeWorkspace } = useWorkspace();
  const { pushToast } = useToast();
  const bootstrapQuery = useOnboardingBootstrapQuery(previewState);
  const [activeStep, setActiveStep] = useState(0);

  const form = useForm<OnboardingFormValues>({
    resolver: zodResolver(OnboardingFormValuesSchema),
    defaultValues: {
      workspaceName: "",
      workspaceSlug: "",
      repositoryIds: [],
      invites: [],
      defaultNotificationChannel: "slack",
      policyPack: "guarded",
      confirmLaunch: false,
    },
    mode: "onBlur",
  });

  const {
    formState: { errors, isDirty, isSubmitting },
    getValues,
    handleSubmit,
    register,
    reset,
    setValue,
    trigger,
    watch,
  } = form;

  const invitesFieldArray = useFieldArray({
    control: form.control,
    name: "invites",
  });

  useEffect(() => {
    if (!bootstrapQuery.data) {
      return;
    }

    reset({
      workspaceName: bootstrapQuery.data.suggestedWorkspaceName,
      workspaceSlug: bootstrapQuery.data.suggestedWorkspaceSlug,
      repositoryIds: bootstrapQuery.data.connectedRepositoryIds,
      invites: bootstrapQuery.data.invites,
      defaultNotificationChannel: bootstrapQuery.data.defaultNotificationChannel,
      policyPack: bootstrapQuery.data.recommendedPolicyPack,
      confirmLaunch: Boolean(bootstrapQuery.data.launchedAt),
    });
  }, [bootstrapQuery.data, reset]);

  const watchedValues = watch();
  const selectedRepositoryIds = watchedValues.repositoryIds;
  const selectedRepositories = useMemo(
    () =>
      bootstrapQuery.data?.availableRepositories.filter((repository) =>
        selectedRepositoryIds.includes(repository.id),
      ) ?? [],
    [bootstrapQuery.data?.availableRepositories, selectedRepositoryIds],
  );

  const launchMutation = useMutation({
    mutationFn: (values: OnboardingFormValues) => launchOnboarding(values),
    onSuccess: async (result) => {
      pushToast({
        description: result.message,
        title: "Workspace launched",
        tone: "success",
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard }),
        queryClient.invalidateQueries({ queryKey: queryKeys.repositories }),
        queryClient.invalidateQueries({ queryKey: queryKeys.onboarding }),
      ]);

      window.setTimeout(() => {
        startTransition(() => {
          router.push(authenticatedRoutes.dashboard);
        });
      }, 900);
    },
    onError: (error) => {
      if (error instanceof ApiClientError) {
        const message =
          typeof error.details === "object" &&
          error.details !== null &&
          "message" in error.details &&
          typeof error.details.message === "string"
            ? error.details.message
            : "Could not launch the workspace. Try again.";
        pushToast({
          description: message,
          title: "Launch failed",
          tone: "error",
        });
        return;
      }

      pushToast({
        description: "Could not launch the workspace. Try again.",
        title: "Launch failed",
        tone: "error",
      });
    },
  });

  async function handleNextStep() {
    const isValid = await trigger(stepFieldMap[activeStep]);

    if (!isValid) {
      return;
    }

    setActiveStep((current) => Math.min(current + 1, onboardingSteps.length - 1));
  }

  function handlePreviousStep() {
    setActiveStep((current) => Math.max(current - 1, 0));
  }

  function toggleRepository(repositoryId: string) {
    const currentValues = getValues("repositoryIds");
    const nextValues = currentValues.includes(repositoryId)
      ? currentValues.filter((id) => id !== repositoryId)
      : [...currentValues, repositoryId];

    setValue("repositoryIds", nextValues, {
      shouldDirty: true,
      shouldTouch: true,
      shouldValidate: true,
    });
  }

  async function onSubmit(values: OnboardingFormValues) {
    await launchMutation.mutateAsync(values);
  }

  if (bootstrapQuery.isPending) {
    return (
      <>
        <PageHeader
          description="Owner-only setup wizard for workspace creation, repository connection, invitations, policy defaults, and launch."
          title="Onboarding"
        />
        <OnboardingSkeleton />
      </>
    );
  }

  if (bootstrapQuery.isError) {
    return (
      <>
        <PageHeader
          description="Owner-only setup wizard for workspace creation, repository connection, invitations, policy defaults, and launch."
          title="Onboarding"
        />
        <PageStatePanel errorMessage="Could not load onboarding setup. Retry." state="error" />
      </>
    );
  }

  const bootstrap = bootstrapQuery.data;

  if (!bootstrap) {
    return (
      <>
        <PageHeader
          description="Owner-only setup wizard for workspace creation, repository connection, invitations, policy defaults, and launch."
          title="Onboarding"
        />
        <EmptyState description="Onboarding data is not available yet." title="No onboarding data" />
      </>
    );
  }

  return (
    <>
      <PageHeader
        actions={
          <Badge tone={isDirty ? "warning" : "success"}>{isDirty ? "Draft in progress" : "Ready to launch"}</Badge>
        }
        description="Owner-only setup wizard for workspace creation, repository connection, invitations, policy defaults, and launch."
        title="Onboarding"
      />

      <div className="grid gap-6 md:grid-cols-3">
        <MetricCard label="Owner access" trend={activeWorkspace.role} value={user.name} />
        <MetricCard
          label="Repositories selected"
          trend={`${bootstrap.availableRepositories.length} available`}
          value={String(selectedRepositoryIds.length)}
        />
        <MetricCard
          label="Launch state"
          trend={
            isRedirecting
              ? "redirecting"
              : bootstrap.launchedAt
                ? "existing workspace state loaded"
                : "step validation enabled"
          }
          value={launchMutation.isSuccess || bootstrap.launchedAt ? "Launched" : `${activeStep + 1}/5`}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.65fr)_minmax(320px,1fr)]">
        <form className="space-y-6" onSubmit={handleSubmit(onSubmit)}>
          <Card className="space-y-6">
            <Stepper currentStep={activeStep} steps={[...onboardingSteps]} />
          </Card>

          {activeStep === 0 ? (
            <Card className="space-y-5">
              <div className="space-y-2">
                <h2 className="text-lg font-semibold">Create the workspace</h2>
                <p className="text-sm text-[var(--ag-text-secondary)]">
                  Step 1 validates the owner-only entry point and the shared workspace naming rules.
                </p>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <Input
                  errorText={errors.workspaceName?.message}
                  helpText="This name appears in the shell, invites, and notification copy."
                  id="onboarding-workspace-name"
                  label="Workspace name"
                  {...register("workspaceName")}
                />
                <Input
                  errorText={errors.workspaceSlug?.message}
                  helpText="Lowercase letters, numbers, and hyphens only."
                  id="onboarding-workspace-slug"
                  label="Workspace slug"
                  {...register("workspaceSlug")}
                />
              </div>
            </Card>
          ) : null}

          {activeStep === 1 ? (
            <Card className="space-y-5">
              <div className="space-y-2">
                <h2 className="text-lg font-semibold">Connect repositories</h2>
                <p className="text-sm text-[var(--ag-text-secondary)]">
                  Step 2 proves card-based selection and required validation before the workspace can launch.
                </p>
              </div>
              {bootstrap.availableRepositories.length === 0 ? (
                <EmptyState
                  description="No repositories are available for this account yet. Connect GitHub and retry."
                  title="No repositories found"
                />
              ) : (
                <div className="space-y-4">
                  {bootstrap.availableRepositories.map((repository) => {
                    const selected = selectedRepositoryIds.includes(repository.id);

                    return (
                      <button
                        className={
                          selected
                            ? "ag-focus-ring flex w-full flex-col gap-3 rounded-[var(--ag-radius-lg)] border border-[var(--ag-color-brand)] bg-[var(--ag-bg-elevated)] p-4 text-left"
                            : "ag-focus-ring flex w-full flex-col gap-3 rounded-[var(--ag-radius-lg)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-card)] p-4 text-left transition-colors hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-elevated)]"
                        }
                        key={repository.id}
                        onClick={(event) => {
                          event.preventDefault();
                          toggleRepository(repository.id);
                        }}
                        type="button"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="space-y-1">
                            <div className="text-base font-semibold">
                              {repository.owner}/{repository.name}
                            </div>
                            <div className="text-sm text-[var(--ag-text-secondary)]">{repository.description}</div>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Badge>{repository.defaultBranch}</Badge>
                            {repository.requiresOrgApproval ? <Badge tone="warning">Org approval</Badge> : null}
                            <Badge tone={selected ? "success" : "neutral"}>{selected ? "Selected" : "Available"}</Badge>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                  {errors.repositoryIds?.message ? (
                    <div className="text-sm text-[var(--ag-color-error)]">{errors.repositoryIds.message}</div>
                  ) : null}
                </div>
              )}
            </Card>
          ) : null}

          {activeStep === 2 ? (
            <Card className="space-y-5">
              <div className="space-y-2">
                <h2 className="text-lg font-semibold">Invite teammates</h2>
                <p className="text-sm text-[var(--ag-text-secondary)]">
                  Step 3 validates dynamic field-array behavior without forcing a team invite before launch.
                </p>
              </div>

              <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3 text-sm text-[var(--ag-text-secondary)]">
                {user.name} will remain the initial workspace owner.
              </div>

              {invitesFieldArray.fields.length > 0 ? (
                <div className="space-y-4">
                  {invitesFieldArray.fields.map((field, index) => (
                    <Card className="space-y-4 bg-[var(--ag-bg-elevated)]" key={field.id}>
                      <div className="flex items-center justify-between gap-3">
                        <h3 className="text-base font-semibold">Invite {index + 1}</h3>
                        <Button onClick={() => invitesFieldArray.remove(index)} size="sm" type="button" variant="ghost">
                          Remove
                        </Button>
                      </div>
                      <div className="grid gap-4 md:grid-cols-2">
                        <Input
                          errorText={errors.invites?.[index]?.name?.message}
                          id={`invite-name-${field.id}`}
                          label="Name"
                          {...register(`invites.${index}.name`)}
                        />
                        <Input
                          errorText={errors.invites?.[index]?.email?.message}
                          id={`invite-email-${field.id}`}
                          label="Email"
                          {...register(`invites.${index}.email`)}
                        />
                      </div>
                      <Select id={`invite-role-${field.id}`} label="Role" {...register(`invites.${index}.role`)}>
                        <option value="member">Member</option>
                        <option value="admin">Admin</option>
                        <option value="owner">Owner</option>
                      </Select>
                    </Card>
                  ))}
                </div>
              ) : (
                <EmptyState
                  description="Invites are optional during the first pass. You can add teammates now or after launch."
                  title="No teammates added yet"
                />
              )}

              <Button
                onClick={() =>
                  invitesFieldArray.append({
                    name: "",
                    email: "",
                    role: "member",
                  })
                }
                type="button"
                variant="secondary"
              >
                Add teammate
              </Button>
            </Card>
          ) : null}

          {activeStep === 3 ? (
            <Card className="space-y-5">
              <div className="space-y-2">
                <h2 className="text-lg font-semibold">Configure the default policy pack</h2>
                <p className="text-sm text-[var(--ag-text-secondary)]">
                  Step 4 validates policy and notification defaults before any repository starts running governed
                  actions.
                </p>
              </div>

              <Select
                id="onboarding-default-notification-channel"
                label="Default notification channel"
                {...register("defaultNotificationChannel")}
              >
                <option value="slack">Slack</option>
                <option value="email">Email</option>
                <option value="in_app">In-app</option>
              </Select>

              <div className="space-y-3">
                <div className="text-[13px] font-semibold text-[var(--ag-text-primary)]">Policy pack</div>
                <div className="grid gap-4 md:grid-cols-3">
                  {(Object.keys(policyPackDescriptions) as PolicyPack[]).map((policyPack) => {
                    const selected = watchedValues.policyPack === policyPack;

                    return (
                      <label
                        className={
                          selected
                            ? "flex cursor-pointer flex-col gap-3 rounded-[var(--ag-radius-lg)] border border-[var(--ag-color-brand)] bg-[var(--ag-bg-elevated)] p-4"
                            : "flex cursor-pointer flex-col gap-3 rounded-[var(--ag-radius-lg)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-card)] p-4 hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-elevated)]"
                        }
                        key={policyPack}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-base font-semibold capitalize">{policyPack}</span>
                          <input
                            className={checkboxClassName()}
                            type="radio"
                            value={policyPack}
                            {...register("policyPack")}
                          />
                        </div>
                        <p className="text-sm text-[var(--ag-text-secondary)]">{policyPackDescriptions[policyPack]}</p>
                      </label>
                    );
                  })}
                </div>
              </div>
            </Card>
          ) : null}

          {activeStep === 4 ? (
            <Card className="space-y-5">
              <div className="space-y-2">
                <h2 className="text-lg font-semibold">Review and launch</h2>
                <p className="text-sm text-[var(--ag-text-secondary)]">
                  Final validation ensures the launch checklist is explicitly confirmed before the dashboard loads.
                </p>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <Card className="space-y-3 bg-[var(--ag-bg-elevated)]">
                  <h3 className="text-base font-semibold">Workspace</h3>
                  <div className="text-sm text-[var(--ag-text-secondary)]">{watchedValues.workspaceName}</div>
                  <div className="font-mono text-xs text-[var(--ag-text-secondary)]">{watchedValues.workspaceSlug}</div>
                </Card>
                <Card className="space-y-3 bg-[var(--ag-bg-elevated)]">
                  <h3 className="text-base font-semibold">Team and policy</h3>
                  <div className="text-sm text-[var(--ag-text-secondary)]">
                    {watchedValues.invites.length} invite{watchedValues.invites.length === 1 ? "" : "s"} ·{" "}
                    {watchedValues.defaultNotificationChannel.replace("_", " ")} · {watchedValues.policyPack}
                  </div>
                </Card>
              </div>

              <div className="space-y-3">
                <h3 className="text-base font-semibold">Selected repositories</h3>
                {selectedRepositories.length > 0 ? (
                  <div className="space-y-3">
                    {selectedRepositories.map((repository) => (
                      <div
                        className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3 text-sm"
                        key={repository.id}
                      >
                        <div className="font-medium">
                          {repository.owner}/{repository.name}
                        </div>
                        <div className="text-[var(--ag-text-secondary)]">{repository.description}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState
                    description="Return to the repository step and pick at least one repository."
                    title="No repositories selected"
                  />
                )}
              </div>

              <label className="flex items-start gap-3 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] p-4">
                <input className={checkboxClassName()} type="checkbox" {...register("confirmLaunch")} />
                <span className="space-y-1">
                  <span className="block text-sm font-semibold text-[var(--ag-text-primary)]">
                    I reviewed the workspace, repositories, team access, and default policy pack.
                  </span>
                  <span className="block text-sm text-[var(--ag-text-secondary)]">
                    Launching sends the workspace into the main dashboard experience with the selected repositories
                    connected.
                  </span>
                </span>
              </label>
              {errors.confirmLaunch?.message ? (
                <div className="text-sm text-[var(--ag-color-error)]">{errors.confirmLaunch.message}</div>
              ) : null}
            </Card>
          ) : null}

          {launchMutation.isError ? (
            <div className="rounded-[var(--ag-radius-md)] border border-[color:rgb(239_68_68_/_0.25)] bg-[var(--ag-bg-error)] px-4 py-3 text-sm text-[var(--ag-color-error)]">
              {launchMutation.error instanceof ApiClientError &&
              typeof launchMutation.error.details === "object" &&
              launchMutation.error.details !== null &&
              "message" in launchMutation.error.details &&
              typeof launchMutation.error.details.message === "string"
                ? launchMutation.error.details.message
                : "Could not launch the workspace. Retry."}
            </div>
          ) : null}

          <Card className="sticky bottom-4 space-y-4 border-[var(--ag-color-brand)] bg-[var(--ag-bg-elevated)]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold">Step controls</h2>
                <p className="text-sm text-[var(--ag-text-secondary)]">
                  Each step validates before progression, and launch uses the same auth-protected API rail as the rest
                  of the app.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={activeStep === 0 || isSubmitting}
                  onClick={handlePreviousStep}
                  type="button"
                  variant="secondary"
                >
                  Back
                </Button>
                {activeStep < onboardingSteps.length - 1 ? (
                  <Button disabled={isSubmitting} onClick={() => void handleNextStep()} type="button">
                    Next
                  </Button>
                ) : (
                  <Button disabled={isSubmitting || isRedirecting} type="submit" variant="accent">
                    {isSubmitting || isRedirecting ? "Launching..." : "Launch workspace"}
                  </Button>
                )}
              </div>
            </div>
          </Card>
        </form>

        <div className="space-y-6">
          <WorkspaceSetupChecklist />

          <Card className="space-y-4">
            <h2 className="text-lg font-semibold">Stepper proof points</h2>
            <div className="space-y-3 text-sm text-[var(--ag-text-secondary)]">
              <p>
                This route validates owner-only access, authenticated bootstrap/loading states, and multi-step RHF
                progression.
              </p>
              <p>
                Repository selection, invite field arrays, and policy defaults all feed the same typed launch payload.
              </p>
              <p>
                The final launch mutation persists workspace connection state and redirects into the dashboard flow.
              </p>
            </div>
          </Card>

          <Card className="space-y-4">
            <h2 className="text-lg font-semibold">Current draft</h2>
            <div className="space-y-3 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3 text-sm text-[var(--ag-text-secondary)]">
              <div>Workspace: {watchedValues.workspaceName || "Untitled"}</div>
              <div>Slug: {watchedValues.workspaceSlug || "unset"}</div>
              <div>Repositories: {selectedRepositoryIds.length}</div>
              <div>Invites: {watchedValues.invites.length}</div>
              <div>Policy pack: {watchedValues.policyPack}</div>
              <div>Notifications: {watchedValues.defaultNotificationChannel.replace("_", " ")}</div>
            </div>
          </Card>

          <Card className="space-y-4">
            <h2 className="text-lg font-semibold">Launch checklist</h2>
            <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3 font-mono text-xs text-[var(--ag-text-secondary)]">
              <div>Before launch:</div>
              <div>- confirm repository scope matches the first governed loop</div>
              <div>- invite the initial operator roster and assign starting roles</div>
              <div>- review the default policy pack and notification channel</div>
              <div>- verify the connector will be installed on the machine that hosts the selected repos</div>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
