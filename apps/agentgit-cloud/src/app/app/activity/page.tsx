import { ScaffoldPage } from "@/features/shared/scaffold-page";

export default function ActivityRoute() {
  return (
    <ScaffoldPage
      description="Workspace-wide activity feed scaffold for recent agent and human actions."
      sections={[
        { title: "Timeline feed", description: "Chronological event rail across repositories.", kind: "status" },
        { title: "Filters", description: "Action type, actor, and repo filters." },
      ]}
      title="Activity"
    />
  );
}
