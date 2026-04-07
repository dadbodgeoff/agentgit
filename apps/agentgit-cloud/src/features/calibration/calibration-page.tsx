"use client";

import { Card } from "@/components/primitives";
import { PageStatePanel } from "@/components/feedback";
import { Button } from "@/components/primitives";
import { ScaffoldPage } from "@/features/shared/scaffold-page";
import { useCalibrationQuery } from "@/lib/query/hooks";
import { parsePreviewState } from "@/lib/navigation/search-params";
import { formatPercent } from "@/lib/utils/format";
import { useSearchParams } from "next/navigation";

export function CalibrationPage(): JSX.Element {
  const searchParams = useSearchParams();
  const previewState = parsePreviewState(searchParams);
  const calibrationQuery = useCalibrationQuery("repo_abc123", previewState);

  if (calibrationQuery.isPending) {
    return (
      <ScaffoldPage actions={<Button variant="secondary">Apply recommended thresholds</Button>} description="Policy calibration dashboard with confidence quality, replay previews, and threshold recommendations." sections={[]} title="Calibration">
        <PageStatePanel state="loading" />
      </ScaffoldPage>
    );
  }

  if (calibrationQuery.isError) {
    return (
      <ScaffoldPage actions={<Button variant="secondary">Apply recommended thresholds</Button>} description="Policy calibration dashboard with confidence quality, replay previews, and threshold recommendations." sections={[]} title="Calibration">
        <PageStatePanel errorMessage="Could not load calibration data. Retry." state="error" />
      </ScaffoldPage>
    );
  }

  const calibration = calibrationQuery.data;

  if (calibration.recommendations.length === 0 && calibration.totalActions < 50) {
    return (
      <ScaffoldPage actions={<Button variant="secondary">Apply recommended thresholds</Button>} description="Policy calibration dashboard with confidence quality, replay previews, and threshold recommendations." sections={[]} title="Calibration">
        <PageStatePanel
          emptyDescription={`Not enough data for calibration. At least 50 actions are needed. Current: ${calibration.totalActions}.`}
          emptyTitle="Not enough calibration data"
          state="empty"
        />
      </ScaffoldPage>
    );
  }

  return (
    <ScaffoldPage
      actions={<Button variant="secondary">Apply recommended thresholds</Button>}
      description="Policy calibration dashboard with confidence quality, replay previews, and threshold recommendations."
      metrics={[
        { label: "Total actions", value: String(calibration.totalActions), trend: calibration.period },
        { label: "Brier score", value: calibration.brierScore.toFixed(2), trend: "lower is better" },
        { label: "ECE", value: calibration.ece.toFixed(2), trend: "expected calibration error" },
      ]}
      sections={[
        { title: "Calibration metrics", description: "Brier score, ECE, and confidence bands." },
        { title: "Recommendations", description: "Per-domain threshold cards with impact preview.", kind: "cards" },
        { title: "Insufficient data handling", description: "Progress rail and messaging for the 50-action minimum.", kind: "status" },
      ]}
      title="Calibration"
    >
      <div className="grid gap-4 md:grid-cols-2">
        {calibration.recommendations.map((recommendation) => (
          <Card className="space-y-3" key={recommendation.domain}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold capitalize">{recommendation.domain}</h2>
              <span className="font-mono text-xs text-[var(--ag-text-secondary)]">
                {formatPercent(recommendation.currentAskThreshold)} → {formatPercent(recommendation.recommended)}
              </span>
            </div>
            <p className="text-sm text-[var(--ag-text-secondary)]">{recommendation.impact}</p>
          </Card>
        ))}
      </div>
    </ScaffoldPage>
  );
}
