import { ScaffoldPage } from "@/features/shared/scaffold-page";

export default function SnapshotsRoute({
  params,
}: {
  params: { owner: string; name: string };
}): JSX.Element {
  const { owner, name } = params;

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
