"use client";

import { useMemo } from "react";

import { Card } from "@/components/primitives";
import { PageStatePanel } from "@/components/feedback";
import { Button } from "@/components/primitives";
import { ScaffoldPage } from "@/features/shared/scaffold-page";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { useCalibrationQuery, useRepositoriesQuery } from "@/lib/query/hooks";
import type { PreviewState } from "@/schemas/cloud";
import { getApiErrorMessage } from "@/lib/api/client";
import { formatPercent } from "@/lib/utils/format";

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
  const repositoriesQuery = useRepositoriesQuery(previewState);
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

  function handleRepositoryChange(nextRepoId: string) {
    const nextSearchParams = new URLSearchParams(searchParams.toString());
    nextSearchParams.set("repoId", nextRepoId);
    router.replace(`${pathname}?${nextSearchParams.toString()}`);
  }

  const actionButton = (
    <Button disabled={!calibrationQuery.data || calibrationQuery.data.recommendations.length === 0} variant="secondary">
      Apply recommended thresholds
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
  const activeRepository = repositories.find((repository) => repository.id === selectedRepoId);

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
      </div>
    </ScaffoldPage>
  );
}
