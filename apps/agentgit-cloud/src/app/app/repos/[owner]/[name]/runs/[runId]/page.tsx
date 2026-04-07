import { parsePreviewStateValue } from "@/lib/navigation/search-params";
import { RunDetailPage } from "@/features/runs/run-detail-page";

export default async function RunDetailRoute({
  params,
  searchParams,
}: {
  params: Promise<{ owner: string; name: string; runId: string }>;
  searchParams?: Promise<{ state?: string | string[] }>;
}) {
  const { owner, name, runId } = await params;
  const resolvedSearchParams = await searchParams;
  const previewState = parsePreviewStateValue(resolvedSearchParams?.state);

  return <RunDetailPage name={name} owner={owner} previewState={previewState} runId={runId} />;
}
