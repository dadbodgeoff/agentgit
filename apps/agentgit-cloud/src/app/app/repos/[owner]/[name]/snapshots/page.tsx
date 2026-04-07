import { ScaffoldPage } from "@/features/shared/scaffold-page";

export default async function SnapshotsRoute({
  params,
}: {
  params: Promise<{ owner: string; name: string }>;
}) {
  const { owner, name } = await params;

  return (
    <ScaffoldPage
      description={`Snapshot inventory scaffold for ${owner}/${name}, including restore affordances and retention states.`}
      sections={[
        { title: "Snapshot table", description: "Restore class, created time, and recoverability signal.", kind: "table" },
        { title: "Restore flow", description: "Review and restore interaction rail.", kind: "status" },
      ]}
      title="Snapshots"
    />
  );
}
