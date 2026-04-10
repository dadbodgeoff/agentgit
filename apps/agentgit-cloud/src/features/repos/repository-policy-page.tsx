"use client";

import { useEffect, useMemo, useState } from "react";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import type { PolicyThresholdRecommendation } from "@agentgit/schemas";

import { MetricCard, PageHeader } from "@/components/composites";
import { EmptyState, LoadingSkeleton, PageStatePanel } from "@/components/feedback";
import {
  Badge,
  Button,
  Card,
  CodeBlock,
  ToastCard,
  ToastViewport,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRoot,
  TableRow,
} from "@/components/primitives";
import { getApiErrorMessage, ApiClientError } from "@/lib/api/client";
import {
  rollbackRepositoryPolicyVersion,
  updateRepositoryPolicy,
  validateRepositoryPolicy,
} from "@/lib/api/endpoints/repositories";
import { queryKeys } from "@/lib/query/keys";
import { useRepositoryPolicyQuery } from "@/lib/query/hooks";
import { formatConfidence } from "@/lib/utils/format";
import {
  RepositoryPolicyDocumentInputSchema,
  type PreviewState,
  type RepositoryPolicyDocumentInput,
  type RepositoryPolicySnapshot,
  type RepositoryPolicyValidation,
  type RepositoryPolicyVersionSummary,
} from "@/schemas/cloud";

function documentClassName() {
  return "ag-focus-ring min-h-[520px] w-full rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] bg-[var(--ag-bg-card)] px-4 py-3 font-mono text-[13px] text-[var(--ag-text-primary)] hover:border-[var(--ag-border-strong)] focus:border-[var(--ag-color-brand)]";
}

function serializePolicyDocument(policy: RepositoryPolicySnapshot["workspaceConfig"]): string {
  return `${JSON.stringify(policy, null, 2)}\n`;
}

function formatSourceScope(scope: string): string {
  return scope.replaceAll("_", " ");
}

function formatChangeSource(source: RepositoryPolicyVersionSummary["changeSource"]): string {
  switch (source) {
    case "rollback":
      return "Rollback";
    case "seed":
      return "Seed";
    default:
      return "Save";
  }
}

function formatPolicyVersionTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function diffTone(change: "added" | "removed" | "changed"): "accent" | "warning" | "neutral" {
  switch (change) {
    case "added":
      return "accent";
    case "removed":
      return "warning";
    default:
      return "neutral";
  }
}

function recommendationTone(recommendation: PolicyThresholdRecommendation): "accent" | "warning" | "neutral" {
  switch (recommendation.direction) {
    case "tighten":
      return "warning";
    case "relax":
      return "accent";
    default:
      return "neutral";
  }
}

function applyRecommendationToDocument(document: string, recommendation: PolicyThresholdRecommendation): string {
  const parsed = JSON.parse(document) as RepositoryPolicySnapshot["workspaceConfig"];
  const thresholds = [...(parsed.thresholds?.low_confidence ?? [])];
  const nextValue = recommendation.recommended_ask_below;

  if (nextValue === null) {
    return document;
  }

  const existingIndex = thresholds.findIndex((entry) => entry.action_family === recommendation.action_family);
  if (existingIndex >= 0) {
    thresholds[existingIndex] = {
      action_family: recommendation.action_family,
      ask_below: nextValue,
    };
  } else {
    thresholds.push({
      action_family: recommendation.action_family,
      ask_below: nextValue,
    });
  }

  thresholds.sort((left, right) => left.action_family.localeCompare(right.action_family));

  return serializePolicyDocument({
    ...parsed,
    thresholds: {
      low_confidence: thresholds,
    },
  });
}

export function RepositoryPolicyPage({
  owner,
  name,
  previewState = "ready",
}: {
  owner: string;
  name: string;
  previewState?: PreviewState;
}) {
  const queryClient = useQueryClient();
  const policyQuery = useRepositoryPolicyQuery(owner, name, previewState);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [errorToast, setErrorToast] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [validationResult, setValidationResult] = useState<RepositoryPolicyValidation | null>(null);
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);

  const form = useForm<RepositoryPolicyDocumentInput>({
    resolver: zodResolver(RepositoryPolicyDocumentInputSchema),
    defaultValues: {
      document: "",
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
    watch,
  } = form;

  useEffect(() => {
    if (!policyQuery.data) {
      return;
    }

    reset({
      document: serializePolicyDocument(policyQuery.data.workspaceConfig),
    });
    setValidationResult(policyQuery.data.validation);
    setSelectedVersionId(policyQuery.data.currentVersionId ?? policyQuery.data.history[0]?.id ?? null);
  }, [policyQuery.data, reset]);

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

  const validateMutation = useMutation({
    mutationFn: (document: string) => validateRepositoryPolicy(owner, name, document),
    onSuccess: (result) => {
      setSubmitError(null);
      setValidationResult(result);
      setToastMessage(result.valid ? "Draft validated." : "Draft has validation issues.");
    },
    onError: (error) => {
      const message = getApiErrorMessage(error, "Could not validate policy draft. Try again.");
      setSubmitError(message);
      setErrorToast(message);
    },
  });

  const saveMutation = useMutation({
    mutationFn: (document: string) => updateRepositoryPolicy(owner, name, document),
    onSuccess: (result) => {
      const nextDocument = serializePolicyDocument(result.policy.workspaceConfig);
      queryClient.setQueryData([...queryKeys.repositoryPolicy(owner, name), previewState], result.policy);
      reset({ document: nextDocument });
      setValidationResult(result.policy.validation);
      setSelectedVersionId(result.policy.currentVersionId ?? result.policy.history[0]?.id ?? null);
      setSubmitError(null);
      setToastMessage(result.message);
    },
    onError: (error) => {
      if (error instanceof ApiClientError) {
        if (
          typeof error.details === "object" &&
          error.details !== null &&
          "issues" in error.details &&
          Array.isArray(error.details.issues)
        ) {
          const message = (error.details.issues as string[]).join(" ");
          setSubmitError(message);
          setErrorToast(message);
          return;
        }
      }

      const message = getApiErrorMessage(error, "Could not save repository policy. Try again.");
      setSubmitError(message);
      setErrorToast(message);
    },
  });

  const rollbackMutation = useMutation({
    mutationFn: (versionId: string) => rollbackRepositoryPolicyVersion(owner, name, versionId),
    onSuccess: (result) => {
      const nextDocument = serializePolicyDocument(result.policy.workspaceConfig);
      queryClient.setQueryData([...queryKeys.repositoryPolicy(owner, name), previewState], result.policy);
      reset({ document: nextDocument });
      setValidationResult(result.policy.validation);
      setSelectedVersionId(result.policy.currentVersionId ?? result.policy.history[0]?.id ?? null);
      setSubmitError(null);
      setToastMessage(result.message);
    },
    onError: (error) => {
      const message = getApiErrorMessage(error, "Could not roll back repository policy. Try again.");
      setSubmitError(message);
      setErrorToast(message);
    },
  });

  const documentValue = watch("document");
  const recommendationCount =
    policyQuery.data?.recommendations.filter((entry) => entry.requires_policy_update).length ?? 0;
  const thresholdCount = policyQuery.data?.workspaceConfig.thresholds?.low_confidence.length ?? 0;
  const appliedThresholdCount = useMemo(() => {
    if (!validationResult?.valid) {
      return thresholdCount;
    }

    try {
      const parsed = JSON.parse(documentValue) as RepositoryPolicySnapshot["workspaceConfig"];
      return parsed.thresholds?.low_confidence.length ?? 0;
    } catch {
      return thresholdCount;
    }
  }, [documentValue, thresholdCount, validationResult?.valid]);

  async function handleValidate() {
    setSubmitError(null);
    await validateMutation.mutateAsync(getValues("document"));
  }

  async function onSubmit(values: RepositoryPolicyDocumentInput) {
    setSubmitError(null);
    const validation = await validateMutation.mutateAsync(values.document);
    if (!validation.valid) {
      return;
    }

    await saveMutation.mutateAsync(values.document);
  }

  function applyRecommendation(recommendation: PolicyThresholdRecommendation) {
    try {
      const nextDocument = applyRecommendationToDocument(getValues("document"), recommendation);
      setValue("document", nextDocument, {
        shouldDirty: true,
        shouldTouch: true,
      });
      setSubmitError(null);
    } catch {
      setSubmitError(
        "The current draft is not valid JSON yet, so a recommendation could not be applied automatically.",
      );
    }
  }

  if (policyQuery.isPending) {
    return (
      <>
        <PageHeader
          description={`Repository governance for ${owner}/${name}, including policy sources, threshold tuning, and admin save controls.`}
          title="Policy"
        />
        <div className="grid gap-6 md:grid-cols-3">
          <MetricCard label="Daemon reachability" value="--" />
          <MetricCard label="Threshold entries" value="--" />
          <MetricCard label="Recommendations" value="--" />
        </div>
        <Card className="space-y-4">
          <LoadingSkeleton className="w-64" />
          <LoadingSkeleton className="w-full" lines={12} />
        </Card>
      </>
    );
  }

  if (policyQuery.isError) {
    return (
      <>
        <PageHeader
          description={`Repository governance for ${owner}/${name}, including policy sources, threshold tuning, and admin save controls.`}
          title="Policy"
        />
        <PageStatePanel
          errorMessage={getApiErrorMessage(policyQuery.error, "Could not load repository policy. Retry.")}
          state="error"
        />
      </>
    );
  }

  if (!policyQuery.data) {
    return (
      <>
        <PageHeader
          description={`Repository governance for ${owner}/${name}, including policy sources, threshold tuning, and admin save controls.`}
          title="Policy"
        />
        <EmptyState
          description="No policy state could be resolved for this repository yet."
          title="No policy available"
        />
      </>
    );
  }

  const policy = policyQuery.data;
  const selectedVersion = policy.history.find((entry) => entry.id === selectedVersionId) ?? policy.history[0] ?? null;
  const selectedVersionIndex = selectedVersion
    ? policy.history.findIndex((entry) => entry.id === selectedVersion.id)
    : -1;
  const previousVersion = selectedVersionIndex >= 0 ? (policy.history[selectedVersionIndex + 1] ?? null) : null;

  return (
    <>
      <PageHeader
        actions={
          <>
            <Badge tone={policy.authorityReachable ? "success" : "warning"}>
              {policy.authorityReachable ? "Daemon reachable" : "Daemon offline"}
            </Badge>
            <Badge tone={isDirty ? "warning" : "success"}>{isDirty ? "Unsaved draft" : "Saved"}</Badge>
          </>
        }
        description={`Repository governance for ${owner}/${name}, including policy sources, threshold tuning, and admin save controls.`}
        title="Policy"
      />

      <div className="grid gap-6 md:grid-cols-3">
        <MetricCard
          label="Daemon reachability"
          trend={policy.hasWorkspaceOverride ? "workspace override present" : "effective policy only"}
          value={policy.authorityReachable ? "Live" : "Offline"}
        />
        <MetricCard label="Threshold entries" trend={`${thresholdCount} saved`} value={String(appliedThresholdCount)} />
        <MetricCard
          label="Recommendations"
          trend={`${policy.loadedSources.length} loaded sources`}
          value={String(recommendationCount)}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(360px,1fr)]">
        <form className="space-y-6" onSubmit={handleSubmit(onSubmit)}>
          <Card className="space-y-4">
            <div className="space-y-2">
              <h2 className="text-lg font-semibold">Workspace policy draft</h2>
              <p className="text-sm text-[var(--ag-text-secondary)]">
                Edit the full policy document as JSON. Saves are normalized to TOML at the repository control path.
              </p>
            </div>

            <label className="flex flex-col gap-1">
              <span className="text-[13px] font-semibold text-[var(--ag-text-primary)]">Policy document</span>
              <textarea
                aria-invalid={errors.document ? true : undefined}
                className={documentClassName()}
                spellCheck={false}
                {...register("document")}
              />
              {errors.document ? (
                <span className="text-[12px] text-[var(--ag-color-error)]">{errors.document.message}</span>
              ) : (
                <span className="text-[12px] text-[var(--ag-text-secondary)]">
                  Path: <span className="font-mono">{policy.policyPath}</span>
                </span>
              )}
            </label>
          </Card>

          {submitError ? (
            <div className="rounded-[var(--ag-radius-md)] border border-[color:rgb(239_68_68_/_0.25)] bg-[var(--ag-bg-error)] px-4 py-3 text-sm text-[var(--ag-color-error)]">
              {submitError}
            </div>
          ) : null}

          <Card className="sticky bottom-4 space-y-4 border-[var(--ag-color-brand)] bg-[var(--ag-bg-elevated)]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold">Validate and apply</h2>
                <p className="text-sm text-[var(--ag-text-secondary)]">
                  Validation runs before save so malformed policy changes never hit the repository control surface.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={isSubmitting || validateMutation.isPending}
                  onClick={handleValidate}
                  type="button"
                  variant="secondary"
                >
                  {validateMutation.isPending ? "Validating..." : "Validate draft"}
                </Button>
                <Button disabled={isSubmitting || saveMutation.isPending} type="submit">
                  {saveMutation.isPending ? "Saving..." : "Save policy"}
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={validationResult?.valid ? "success" : "warning"}>
                {validationResult?.valid ? "Draft valid" : "Validation required"}
              </Badge>
              {validationResult?.compiledProfileName ? <Badge>{validationResult.compiledProfileName}</Badge> : null}
              {typeof validationResult?.compiledRuleCount === "number" ? (
                <Badge>{validationResult.compiledRuleCount} compiled rules</Badge>
              ) : null}
            </div>

            {validationResult && !validationResult.valid && validationResult.issues.length > 0 ? (
              <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-card)] p-4">
                <div className="mb-2 text-sm font-semibold text-[var(--ag-text-primary)]">Validation issues</div>
                <ul className="space-y-1 text-sm text-[var(--ag-text-secondary)]">
                  {validationResult.issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Card>
        </form>

        <div className="space-y-6">
          <Card className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Version history</h2>
                <p className="text-sm text-[var(--ag-text-secondary)]">
                  Every saved or rolled back workspace override is retained with actor attribution and a diff from the
                  prior version.
                </p>
              </div>
              <Badge tone={policy.history.length > 0 ? "accent" : "neutral"}>{policy.history.length} versions</Badge>
            </div>

            {policy.history.length === 0 ? (
              <EmptyState
                description="History begins with the first saved workspace override for this repository."
                title="No saved policy versions yet"
              />
            ) : (
              <div className="space-y-3">
                {policy.history.map((version) => {
                  const isSelected = version.id === selectedVersion?.id;
                  return (
                    <button
                      className={`w-full rounded-[var(--ag-radius-md)] border px-4 py-3 text-left transition ${
                        isSelected
                          ? "border-[var(--ag-color-brand)] bg-[var(--ag-bg-elevated)]"
                          : "border-[var(--ag-border-subtle)] bg-[var(--ag-bg-card)] hover:border-[var(--ag-border-strong)]"
                      }`}
                      key={version.id}
                      onClick={() => setSelectedVersionId(version.id)}
                      type="button"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-[var(--ag-text-primary)]">
                            {version.profileName}
                          </div>
                          <div className="text-xs text-[var(--ag-text-secondary)]">
                            {formatPolicyVersionTimestamp(version.createdAt)} by {version.actorName}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          {version.isCurrent ? <Badge tone="success">Current</Badge> : null}
                          <Badge tone="neutral">{formatChangeSource(version.changeSource)}</Badge>
                          <Badge>{version.policyVersion}</Badge>
                        </div>
                      </div>
                      <p className="mt-2 text-sm text-[var(--ag-text-secondary)]">{version.summary}</p>
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Badge tone="accent">{version.ruleCount} rules</Badge>
                        <Badge tone="neutral">{version.thresholdCount} thresholds</Badge>
                        <Badge tone="neutral">{version.diffFromPrevious.length} diff entries</Badge>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            {selectedVersion ? (
              <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-base font-semibold">Selected diff</h3>
                    <p className="text-sm text-[var(--ag-text-secondary)]">
                      {previousVersion
                        ? "Comparing this saved version against the version immediately before it."
                        : "This is the oldest retained version, so there is no prior saved version to compare against."}
                    </p>
                  </div>
                  {!selectedVersion.isCurrent ? (
                    <Button
                      disabled={rollbackMutation.isPending}
                      onClick={() => rollbackMutation.mutate(selectedVersion.id)}
                      size="sm"
                      type="button"
                      variant="secondary"
                    >
                      {rollbackMutation.isPending ? "Rolling back..." : "Roll back to this version"}
                    </Button>
                  ) : (
                    <Badge tone="success">Active version</Badge>
                  )}
                </div>

                <div className="mt-4 space-y-3">
                  {selectedVersion.diffFromPrevious.length === 0 ? (
                    <EmptyState
                      description={
                        previousVersion
                          ? "This saved version has no effective diff from the prior one."
                          : "This version is the baseline for future policy changes."
                      }
                      title={previousVersion ? "No effective diff" : "Baseline version"}
                    />
                  ) : (
                    selectedVersion.diffFromPrevious.map((entry) => (
                      <div
                        className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-card)] p-4"
                        key={entry.id}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={diffTone(entry.change)}>{entry.change}</Badge>
                          <Badge tone="neutral">{entry.section}</Badge>
                          <div className="text-sm font-semibold text-[var(--ag-text-primary)]">{entry.label}</div>
                        </div>
                        <div className="mt-3 grid gap-3 lg:grid-cols-2">
                          <div>
                            <div className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ag-text-secondary)]">
                              Before
                            </div>
                            <CodeBlock className="min-h-0">{entry.before ?? "Not set"}</CodeBlock>
                          </div>
                          <div>
                            <div className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--ag-text-secondary)]">
                              After
                            </div>
                            <CodeBlock className="min-h-0">{entry.after ?? "Removed"}</CodeBlock>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                <div className="mt-4 grid gap-4 xl:grid-cols-2">
                  <div>
                    <div className="mb-2 text-sm font-semibold text-[var(--ag-text-primary)]">Selected document</div>
                    <CodeBlock>{selectedVersion.document}</CodeBlock>
                  </div>
                  {previousVersion ? (
                    <div>
                      <div className="mb-2 text-sm font-semibold text-[var(--ag-text-primary)]">Previous version</div>
                      <CodeBlock>{previousVersion.document}</CodeBlock>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </Card>

          <Card className="space-y-4">
            <h2 className="text-lg font-semibold">Loaded sources</h2>
            <div className="space-y-3">
              {policy.loadedSources.map((source) => (
                <div
                  className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] p-4"
                  key={`${source.scope}:${source.path ?? "builtin"}`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge>{formatSourceScope(source.scope)}</Badge>
                    <Badge tone="neutral">{source.policy_version}</Badge>
                    <Badge tone="accent">{source.rule_count} rules</Badge>
                  </div>
                  <div className="mt-2 text-sm font-medium text-[var(--ag-text-primary)]">{source.profile_name}</div>
                  <div className="mt-1 break-all font-mono text-xs text-[var(--ag-text-secondary)]">
                    {source.path ?? "Built-in default policy pack"}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">Threshold recommendations</h2>
              <Badge tone={recommendationCount > 0 ? "warning" : "success"}>
                {recommendationCount > 0 ? `${recommendationCount} actionable` : "No changes suggested"}
              </Badge>
            </div>

            {policy.recommendations.length === 0 ? (
              <EmptyState
                description="Calibration history has not produced any threshold advice for this repository yet."
                title="No recommendations"
              />
            ) : (
              <div className="space-y-3">
                {policy.recommendations.map((recommendation) => (
                  <div
                    className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] p-4"
                    key={recommendation.action_family}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="space-y-1">
                        <div className="text-sm font-semibold text-[var(--ag-text-primary)]">
                          {recommendation.action_family}
                        </div>
                        <div className="text-xs text-[var(--ag-text-secondary)]">
                          Current{" "}
                          {recommendation.current_ask_below === null
                            ? "none"
                            : formatConfidence(recommendation.current_ask_below)}{" "}
                          · Recommended{" "}
                          {recommendation.recommended_ask_below === null
                            ? "none"
                            : formatConfidence(recommendation.recommended_ask_below)}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={recommendationTone(recommendation)}>{recommendation.direction}</Badge>
                        <Button
                          disabled={recommendation.recommended_ask_below === null}
                          onClick={() => applyRecommendation(recommendation)}
                          size="sm"
                          type="button"
                          variant="secondary"
                        >
                          Apply to draft
                        </Button>
                      </div>
                    </div>
                    <p className="mt-3 text-sm text-[var(--ag-text-secondary)]">{recommendation.rationale}</p>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="space-y-4">
            <h2 className="text-lg font-semibold">Effective runtime</h2>
            <TableRoot>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Action family</TableHeaderCell>
                  <TableHeaderCell>Ask below</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(policy.effectivePolicy.policy.thresholds?.low_confidence ?? []).map((threshold) => (
                  <TableRow key={threshold.action_family}>
                    <TableCell className="font-mono">{threshold.action_family}</TableCell>
                    <TableCell>{formatConfidence(threshold.ask_below)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </TableRoot>

            <div className="space-y-2">
              <div className="text-sm font-semibold text-[var(--ag-text-primary)]">Compiled rule coverage</div>
              <CodeBlock>
                {policy.effectivePolicy.policy.rules
                  .map((rule) => `${rule.rule_id} (${rule.enforcement_mode})`)
                  .join("\n")}
              </CodeBlock>
            </div>
          </Card>
        </div>
      </div>

      {toastMessage ? (
        <ToastViewport>
          <ToastCard className="border-[color:rgb(34_197_94_/_0.28)]">
            <div className="space-y-1">
              <div className="text-sm font-semibold text-[var(--ag-text-primary)]">Policy saved</div>
              <p className="text-sm text-[var(--ag-text-secondary)]">{toastMessage}</p>
            </div>
          </ToastCard>
        </ToastViewport>
      ) : null}
      {errorToast ? (
        <ToastViewport>
          <ToastCard className="border-[color:rgb(239_68_68_/_0.28)]">
            <div className="space-y-1">
              <div className="text-sm font-semibold text-[var(--ag-text-primary)]">Policy action failed</div>
              <p className="text-sm text-[var(--ag-text-secondary)]">{errorToast}</p>
            </div>
          </ToastCard>
        </ToastViewport>
      ) : null}
    </>
  );
}
