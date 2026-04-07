import { ScaffoldPage } from "@/features/shared/scaffold-page";

export default function SettingsRoute() {
  return (
    <ScaffoldPage
      description="Workspace settings scaffold with fixed save bar and section navigation."
      sections={[
        { title: "Settings sections", description: "General, pipeline, environments, notifications, integrations." },
        { title: "Save model", description: "Dirty tracking and explicit save handling.", kind: "status" },
      ]}
      title="Workspace settings"
    />
  );
}
