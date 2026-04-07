"use client";

import { ApprovalCard } from "@/components/composites";
import { Card } from "@/components/primitives";
import { PageStatePanel } from "@/components/feedback";
import { ScaffoldPage } from "@/features/shared/scaffold-page";
import { useApprovalsQuery } from "@/lib/query/hooks";
import { parsePreviewState } from "@/lib/navigation/search-params";
import { formatConfidence, formatRelativeTimestamp } from "@/lib/utils/format";
import { useSearchParams } from "next/navigation";

export function ApprovalQueuePage() {
  const searchParams = useSearchParams();
  const previewState = parsePreviewState(searchParams);
  const approvalsQuery = useApprovalsQuery(previewState);

  if (approvalsQuery.isPending) {
    return (
      <ScaffoldPage description="Agent actions that crossed policy thresholds and require a human decision." sections={[]} title="Approval queue">
        <PageStatePanel state="loading" />
      </ScaffoldPage>
    );
  }

  if (approvalsQuery.isError) {
    return (
      <ScaffoldPage description="Agent actions that crossed policy thresholds and require a human decision." sections={[]} title="Approval queue">
        <PageStatePanel errorMessage="Could not load approvals. Retry." state="error" />
      </ScaffoldPage>
    );
  }

  const approvals = approvalsQuery.data;

  if (approvals.items.length === 0) {
    return (
      <ScaffoldPage description="Agent actions that crossed policy thresholds and require a human decision." sections={[]} title="Approval queue">
        <PageStatePanel
          emptyDescription="No pending approvals. The agent will notify you when your input is needed."
          emptyTitle="No pending approvals"
          state="empty"
        />
      </ScaffoldPage>
    );
  }

  return (
    <ScaffoldPage
      description="Agent actions that crossed policy thresholds and require a human decision."
      metrics={[
        { label: "Pending approvals", value: String(approvals.total), trend: "workspace-wide" },
        { label: "Highest confidence", value: formatConfidence(Math.max(...approvals.items.map((item) => item.confidence))), trend: "still required review" },
        { label: "Oldest request", value: formatRelativeTimestamp(approvals.items[approvals.items.length - 1]?.requestedAt ?? approvals.items[0].requestedAt) },
      ]}
      sections={[
        { title: "Approval cards", description: "Card list with diff, rationale, confidence, and actions.", kind: "approval" },
        { title: "Expired approvals", description: "Collapsed section for expired items and concurrency handling.", kind: "status" },
      ]}
      title="Approval queue"
    >
      <Card className="space-y-4">
        <h2 className="text-lg font-semibold">Pending approvals</h2>
        <div className="space-y-4">
          {approvals.items.map((item) => (
            <ApprovalCard confidence={item.confidence} key={item.id} repo={`${item.repo} · ${item.branch}`} summary={item.actionSummary} />
          ))}
        </div>
      </Card>
    </ScaffoldPage>
  );
}
