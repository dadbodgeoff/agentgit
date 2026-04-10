"use client";

import { useEffect, useMemo, useState } from "react";

import Link from "next/link";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Card } from "@/components/primitives";
import { PageStatePanel } from "@/components/feedback";
import { Badge, Button, ToastCard, ToastViewport } from "@/components/primitives";
import { ScaffoldPage } from "@/features/shared/scaffold-page";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { useCalibrationQuery, useRepositoriesQuery } from "@/lib/query/hooks";
import { getRepositoryPolicy, updateRepositoryPolicy } from "@/lib/api/endpoints/repositories";
import { replayCalibrationThresholds } from "@/lib/api/endpoints/calibration";
import { queryKeys } from "@/lib/query/keys";
import type { PreviewState } from "@/schemas/cloud";
import { getApiErrorMessage } from "@/lib/api/client";
import { formatPercent } from "@/lib/utils/format";
import { repositoryPolicyRoute } from "@/lib/navigation/routes";

function applyThresholdsToPolicyDocument(
  workspaceConfig: Awaited<ReturnType<typeof getRepositoryPolicy>>["workspaceConfig"],
  candidateThresholds: Array<{ actionFamily: string; askBelow: number }>,
) {
  const thresholdMap = new Map(
    (workspaceConfig.thresholds?.low_confidence ?? []).map((threshold) => [threshold.action_family, threshold.ask_below]),
  );

  for (const threshold of candidateThresholds) {
    thresholdMap.set(threshold.actionFamily, threshold.askBelow);
  }

  const nextThresholds = [...thresholdMap.entries()]
    .map(([action_family, ask_below]) => ({
      action_family,
      ask_below,
    }))
    .sort((left, right) => left.action_family.localeCompare(right.action_family));

  return `${JSON.stringify(
    {
      ...workspaceConfig,
      thresholds: {
        low_confidence: nextThresholds,
      },
    },
    null,
    2,
  )}\n`;
}

function selectClassName() {
  return "ag-focus-ring h-9 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] bg-[var(--ag-bg-card)] px-3 text-[14px] text-[var(--ag-text-primary)] hover:border-[var(--ag-border-strong)] focus:border-[var(--ag-color-brand)]";
}

export function CalibrationPage({
  initialRepoId,
  previewState = "ready",
}: {
  initialRepoId?: string;
  previewState?: PreviewState;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const repositoriesQuery = useRepositoriesQuery(previewState);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [errorToast, setErrorToast] = useState<string | null>(null);
  const repositories = repositoriesQuery.data?.items ?? [];
  const selectedRepoId = useMemo(() => {
    if (repositories.length === 0) {
      return null;
    }

    return repositories.some((repository) => repository.id === initialRepoId)
      ? initialRepoId!
      : (repositories[0]?.id ?? null);
  }, [initialRepoId, repositories]);
  const calibrationQuery = useCalibrationQuery(
    selectedRepoId,
    previewState,
    repositoriesQuery.isSuccess && Boolean(selectedRepoId),
  );
  const activeRepository = repositories.find((repository) => repository.id === selectedRepoId) ?? null;
  const actionableRecommendations = calibrationQuery.data
    ? calibrationQuery.data.recommendations.filter((recommendation) => recommendation.currentAskThreshold !== recommendation.recommended)
    : [];
  const policyQuery = useQuery({
    queryKey: ["repository-policy-for-calibration", activeRepository?.owner ?? "none", activeRepository?.name ?? "none"],
    queryFn: () => getRepositoryPolicy(activeRepository?.owner ?? "", activeRepository?.name ?? ""),
    enabled: previewState === "ready" && Boolean(activeRepository),
  });
  const replayMutation = useMutation({
    mutationFn: () =>
      replayCalibrationThresholds(selectedRepoId ?? "", {
        candidateThresholds: actionableRecommendations.map((recommendation) => ({
          actionFamily: recommendation.domain,
          askBelow: recommendation.recommended,
        })),
      }),
    onError: (error) => {
      const message = getApiErrorMessage(error, "Could not preview threshold replay. Retry.");
      setErrorToast(message);
    },
  });
  const applyMutation = useMutation({
    mutationFn: async () => {
      if (!activeRepository || !policyQuery.data || !replayMutation.data) {
        throw new Error("Calibration preview is not ready yet.");
      }

      const nextDocument = applyThresholdsToPolicyDocument(
        policyQuery.data.workspaceConfig,
        replayMutation.data.candidateThresholds,
      );
      return updateRepositoryPolicy(activeRepository.owner, activeRepository.name, nextDocument);
    },
    onSuccess: (result) => {
      if (!selectedRepoId) {
        return;
      }

      void queryClient.invalidateQueries({ queryKey: queryKeys.calibration(selectedRepoId) });
      if (activeRepository) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.repositoryPolicy(activeRepository.owner, activeRepository.name) });
      }
      setToastMessage(result.message);
    },
    onError: (error) => {
      const message = getApiErrorMessage(error, "Could not apply threshold update. Retry.");
      setErrorToast(message);
    },
  });

  useEffect(() => {
    if (!toastMessage && !errorToast) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setToastMessage(null);
      setErrorToast(null);
    }, 4000);

    return () => window.clearTimeout(timeout);
  }, [toastMessage, errorToast]);

  useEffect(() => {
    replayMutation.reset();
    applyMutation.reset();
    setToastMessage(null);
    setErrorToast(null);
  }, [selectedRepoId]);

  function handleRepositoryChange(nextRepoId: string) {
    const nextSearchParams = new URLSearchParams(searchParams.toString());
    nextSearchParams.set("repoId", nextRepoId);
    router.replace(`${pathname}?${nextSearchParams.toString()}`);
  }

  const actionButton = replayMutation.data ? (
    <Button
      disabled={applyMutation.isPending || !policyQuery.data}
      onClick={() => applyMutation.mutate()}
      variant="secondary"
    >
      {applyMutation.isPending ? "Applying..." : "Apply recommended thresholds"}
    </Button>
  ) : (
    <Button
      disabled={actionableRecommendations.length === 0 || replayMutation.isPending}
      onClick={() => replayMutation.mutate()}
      variant="secondary"
    >
      {replayMutation.isPending ? "Previewing..." : "Preview threshold update"}
    </Button>
  );

  if (repositoriesQuery.isPending) {
    return (
      <ScaffoldPage
        actions={actionButton}
        description="Policy calibration dashboard with confidence quality, replay previews, and threshold recommendations."
        sections={[]}
        title="Calibration"
      >
        <PageStatePanel state="loading" />
      </ScaffoldPage>
    );
  }

  if (repositoriesQuery.isError) {
    return (
      <ScaffoldPage
        actions={actionButton}
        description="Policy calibration dashboard with confidence quality, replay previews, and threshold recommendations."
        sections={[]}
        title="Calibration"
      >
        <PageStatePanel
          errorMessage={getApiErrorMessage(repositoriesQuery.error, "Could not load repositories. Retry.")}
          state="error"
        />
      </ScaffoldPage>
    );
  }

  if (repositories.length === 0 || !selectedRepoId) {
    return (
      <ScaffoldPage
        actions={actionButton}
        description="Policy calibration dashboard with confidence quality, replay previews, and threshold recommendations."
        sections={[]}
        title="Calibration"
      >
        <PageStatePanel
          emptyDescription="Connect at least one governed repository before reviewing calibration quality."
          emptyTitle="No repositories available"
          state="empty"
        />
      </ScaffoldPage>
    );
  }

  if (calibrationQuery.isPending) {
    return (
      <ScaffoldPage
        actions={actionButton}
        description="Policy calibration dashboard with confidence quality, replay previews, and threshold recommendations."
        sections={[]}
        title="Calibration"
      >
        <PageStatePanel state="loading" />
      </ScaffoldPage>
    );
  }

  if (calibrationQuery.isError) {
    return (
      <ScaffoldPage
        actions={actionButton}
        description="Policy calibration dashboard with confidence quality, replay previews, and threshold recommendations."
        sections={[]}
        title="Calibration"
      >
        <PageStatePanel
          errorMessage={getApiErrorMessage(calibrationQuery.error, "Could not load calibration data. Retry.")}
          state="error"
        />
      </ScaffoldPage>
    );
  }

  const calibration = calibrationQuery.data;

  if (calibration.recommendations.length === 0 && calibration.totalActions < 50) {
    return (
      <ScaffoldPage
        actions={actionButton}
        description="Policy calibration dashboard with confidence quality, replay previews, and threshold recommendations."
        sections={[]}
        title="Calibration"
      >
        <div className="space-y-4">
          <Card className="space-y-2">
            <label className="flex flex-col gap-1">
              <span className="text-[13px] font-semibold text-[var(--ag-text-primary)]">Repository</span>
              <select
                className={selectClassName()}
                onChange={(event) => handleRepositoryChange(event.target.value)}
                value={selectedRepoId}
              >
                {repositories.map((repository) => (
                  <option key={repository.id} value={repository.id}>
                    {repository.owner}/{repository.name}
                  </option>
                ))}
              </select>
            </label>
          </Card>
          <PageStatePanel
            emptyDescription={`Not enough data for calibration. At least 50 actions are needed. Current: ${calibration.totalActions}.`}
            emptyTitle="Not enough calibration data"
            state="empty"
          />
        </div>
      </ScaffoldPage>
    );
  }

  return (
    <ScaffoldPage
      actions={actionButton}
      description="Policy calibration dashboard with confidence quality, replay previews, and threshold recommendations."
      metrics={[
        {
          label: "Repository",
          value: activeRepository ? `${activeRepository.owner}/${activeRepository.name}` : calibration.repoId,
          trend: calibration.period,
        },
        { label: "Total actions", value: String(calibration.totalActions), trend: calibration.period },
        { label: "Brier score", value: calibration.brierScore.toFixed(2), trend: "lower is better" },
        { label: "ECE", value: calibration.ece.toFixed(2), trend: "expected calibration error" },
      ]}
      sections={[
        { title: "Calibration metrics", description: "Brier score, ECE, and confidence bands." },
        { title: "Recommendations", description: "Per-domain threshold cards with impact preview.", kind: "cards" },
        {
          title: "Insufficient data handling",
          description: "Progress rail and messaging for the 50-action minimum.",
          kind: "status",
        },
      ]}
      title="Calibration"
    >
      <div className="space-y-4">
        <Card className="space-y-2">
          <label className="flex flex-col gap-1">
            <span className="text-[13px] font-semibold text-[var(--ag-text-primary)]">Repository</span>
            <select
              className={selectClassName()}
              onChange={(event) => handleRepositoryChange(event.target.value)}
              value={selectedRepoId}
            >
              {repositories.map((repository) => (
                <option key={repository.id} value={repository.id}>
                  {repository.owner}/{repository.name}
                </option>
              ))}
            </select>
            <span className="text-[12px] text-[var(--ag-text-secondary)]">
              Calibration is scoped to the selected governed repository.
            </span>
          </label>
        </Card>
        <div className="grid gap-4 md:grid-cols-2">
          {calibration.recommendations.map((recommendation) => (
            <Card className="space-y-3" key={recommendation.domain}>
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold">{recommendation.domain}</h2>
                <span className="font-mono text-xs text-[var(--ag-text-secondary)]">
                  {formatPercent(recommendation.currentAskThreshold)} → {formatPercent(recommendation.recommended)}
                </span>
              </div>
              <p className="text-sm text-[var(--ag-text-secondary)]">{recommendation.impact}</p>
            </Card>
          ))}
        </div>
        <Card className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Threshold replay preview</h2>
              <p className="text-sm text-[var(--ag-text-secondary)]">
                Review the projected approval impact before saving the updated policy thresholds.
              </p>
            </div>
            {replayMutation.data ? <Badge tone="accent">{replayMutation.data.summary.changedDecisions} changed</Badge> : null}
          </div>
          {actionableRecommendations.length === 0 ? (
            <PageStatePanel
              emptyDescription="Current recommendations do not change any stored thresholds for this repository."
              emptyTitle="No actionable threshold changes"
              state="empty"
            />
          ) : replayMutation.isPending ? (
            <PageStatePanel state="loading" />
          ) : replayMutation.data ? (
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3">
                  <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-tertiary)]">Replayable</div>
                  <div className="mt-1 text-lg font-semibold">{replayMutation.data.summary.replayableSamples}</div>
                </div>
                <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3">
                  <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-tertiary)]">Approvals reduced</div>
                  <div className="mt-1 text-lg font-semibold">{replayMutation.data.summary.approvalsReduced}</div>
                </div>
                <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3">
                  <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-tertiary)]">Approvals increased</div>
                  <div className="mt-1 text-lg font-semibold">{replayMutation.data.summary.approvalsIncreased}</div>
                </div>
                <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3">
                  <div className="text-xs uppercase tracking-[0.06em] text-[var(--ag-text-tertiary)]">Unsafe auto-allow</div>
                  <div className="mt-1 text-lg font-semibold">
                    {replayMutation.data.summary.historicallyDeniedAutoAllowed}
                  </div>
                </div>
              </div>
              <div className="space-y-2">
                {replayMutation.data.actionFamilies.map((family) => (
                  <div
                    className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3"
                    key={family.domain}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="font-medium">{family.domain}</div>
                      <div className="font-mono text-xs text-[var(--ag-text-secondary)]">
                        {family.currentAskThreshold === null ? "none" : formatPercent(family.currentAskThreshold)} to{" "}
                        {family.candidateAskThreshold === null ? "none" : formatPercent(family.candidateAskThreshold)}
                      </div>
                    </div>
                    <div className="mt-2 text-sm text-[var(--ag-text-secondary)]">
                      {family.replayableSamples} replayable sample{family.replayableSamples === 1 ? "" : "s"}, {family.changedDecisions} changed decision{family.changedDecisions === 1 ? "" : "s"}, {family.approvalsReduced} approval reduction, {family.approvalsIncreased} approval increase.
                    </div>
                  </div>
                ))}
              </div>
              {policyQuery.data && activeRepository ? (
                <div className="space-y-3">
                  <div className="text-sm font-medium text-[var(--ag-text-primary)]">Generated policy document</div>
                  <pre className="overflow-x-auto rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3 text-xs text-[var(--ag-text-secondary)]">
                    {applyThresholdsToPolicyDocument(policyQuery.data.workspaceConfig, replayMutation.data.candidateThresholds)}
                  </pre>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button disabled={applyMutation.isPending} onClick={() => applyMutation.mutate()} variant="secondary">
                      {applyMutation.isPending ? "Applying..." : "Apply recommended thresholds"}
                    </Button>
                    <Link
                      className="text-sm font-medium text-[var(--ag-color-brand)] underline-offset-4 hover:underline"
                      href={repositoryPolicyRoute(activeRepository.owner, activeRepository.name)}
                    >
                      Open repository policy
                    </Link>
                  </div>
                </div>
              ) : (
                <div className="text-sm text-[var(--ag-text-secondary)]">
                  Loading the current repository policy before apply is enabled.
                </div>
              )}
            </div>
          ) : (
            <div className="text-sm text-[var(--ag-text-secondary)]">
              Preview the recommended threshold update before applying it to repository policy.
            </div>
          )}
        </Card>
      </div>
      {toastMessage ? (
        <ToastViewport>
          <ToastCard className="border-[color:rgb(34_197_94_/_0.28)]">
            <div className="space-y-1">
              <div className="text-sm font-semibold text-[var(--ag-text-primary)]">Calibration applied</div>
              <p className="text-sm text-[var(--ag-text-secondary)]">{toastMessage}</p>
            </div>
          </ToastCard>
        </ToastViewport>
      ) : null}
      {errorToast ? (
        <ToastViewport>
          <ToastCard className="border-[color:rgb(239_68_68_/_0.28)]">
            <div className="space-y-1">
              <div className="text-sm font-semibold text-[var(--ag-text-primary)]">Calibration failed</div>
              <p className="text-sm text-[var(--ag-text-secondary)]">{errorToast}</p>
            </div>
          </ToastCard>
        </ToastViewport>
      ) : null}
    </ScaffoldPage>
  );
}
