"use client";

import { Card, CodeBlock } from "@/components/primitives";
import { PageStatePanel } from "@/components/feedback";
import { Button } from "@/components/primitives";
import { ScaffoldPage } from "@/features/shared/scaffold-page";
import { useRunDetailQuery } from "@/lib/query/hooks";
import { parsePreviewState } from "@/lib/navigation/search-params";
import { formatRelativeTimestamp } from "@/lib/utils/format";
import { useSearchParams } from "next/navigation";

export function RunDetailPage({
  owner,
  name,
  runId,
}: {
  owner: string;
  name: string;
  runId: string;
}): JSX.Element {
  const searchParams = useSearchParams();
  const previewState = parsePreviewState(searchParams);
  const runQuery = useRunDetailQuery(runId, previewState);

  if (runQuery.isPending) {
    return (
      <ScaffoldPage actions={<Button variant="secondary">Restore snapshot</Button>} description={`Detailed run timeline for ${owner}/${name} run ${runId}, including action ordering, policy outcomes, and recovery context.`} sections={[]} title="Run detail">
        <PageStatePanel state="loading" />
      </ScaffoldPage>
    );
  }

  if (runQuery.isError) {
    return (
      <ScaffoldPage actions={<Button variant="secondary">Restore snapshot</Button>} description={`Detailed run timeline for ${owner}/${name} run ${runId}, including action ordering, policy outcomes, and recovery context.`} sections={[]} title="Run detail">
        <PageStatePanel errorMessage="Could not load run detail. Retry." state="error" />
      </ScaffoldPage>
    );
  }

  const run = runQuery.data;

  return (
    <ScaffoldPage
      actions={<Button variant="secondary">Restore snapshot</Button>}
      description={`Detailed run timeline for ${owner}/${name} run ${runId}, including action ordering, policy outcomes, and recovery context.`}
      metrics={[
        { label: "Actions", value: String(run.actionCount), trend: `${run.actionsAsked} required approval` },
        { label: "Snapshots", value: String(run.snapshotsTaken), trend: "recovery boundaries captured" },
        { label: "Started", value: formatRelativeTimestamp(run.startedAt), trend: run.runtime },
      ]}
      sections={[
        { title: "Run summary", description: "Header, status badge, duration, and snapshot availability." },
        { title: "Action timeline", description: "Paginated timeline with sticky jump-to-error behavior.", kind: "table" },
        { title: "Execution log viewer", description: "Monospace log surface with download fallback for large output.", kind: "code" },
      ]}
      title="Run detail"
    >
      <Card className="space-y-4">
        <h2 className="text-lg font-semibold">Run payload</h2>
        <CodeBlock>{JSON.stringify(run, null, 2)}</CodeBlock>
      </Card>
    </ScaffoldPage>
  );
}
