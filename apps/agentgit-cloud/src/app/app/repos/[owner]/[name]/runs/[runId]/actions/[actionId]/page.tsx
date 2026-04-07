import { ScaffoldPage } from "@/features/shared/scaffold-page";

export default async function ActionDetailRoute({
  params,
}: {
  params: Promise<{ owner: string; name: string; runId: string; actionId: string }>;
}) {
  const { owner, name, runId, actionId } = await params;

  return (
    <ScaffoldPage
      description={`Action detail scaffold for ${owner}/${name} run ${runId}, action ${actionId}.`}
      sections={[
        { title: "Normalized action", description: "Canonical action payload and policy match details.", kind: "code" },
        { title: "Execution details", description: "Execution timing, exit code, artifacts, and snapshot references." },
      ]}
      title="Action detail"
    />
  );
}
