import { ActionDetailPage } from "@/features/runs/action-detail-page";

export default async function ActionDetailRoute({
  params,
}: {
  params: Promise<{ owner: string; name: string; runId: string; actionId: string }>;
}) {
  const { owner, name, runId, actionId } = await params;

  return <ActionDetailPage actionId={actionId} name={name} owner={owner} runId={runId} />;
}
