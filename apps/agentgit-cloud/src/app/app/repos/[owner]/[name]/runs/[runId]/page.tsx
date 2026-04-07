import { RunDetailPage } from "@/features/runs/run-detail-page";

export default async function RunDetailRoute({
  params,
}: {
  params: Promise<{ owner: string; name: string; runId: string }>;
}) {
  const { owner, name, runId } = await params;

  return <RunDetailPage name={name} owner={owner} runId={runId} />;
}
