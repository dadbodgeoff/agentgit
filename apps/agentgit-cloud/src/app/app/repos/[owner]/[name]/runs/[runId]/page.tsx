import { RunDetailPage } from "@/features/runs/run-detail-page";

export default function RunDetailRoute({
  params,
}: {
  params: { owner: string; name: string; runId: string };
}): JSX.Element {
  const { owner, name, runId } = params;

  return <RunDetailPage name={name} owner={owner} runId={runId} />;
}
