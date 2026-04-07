import { ScaffoldPage } from "@/features/shared/scaffold-page";

export default function TeamSettingsRoute() {
  return (
    <ScaffoldPage
      description="Team management scaffold for invitations, roles, and membership actions."
      sections={[
        { title: "Team roster", description: "User list with role and status columns.", kind: "table" },
        { title: "Invite flow", description: "Email or GitHub username invite surface." },
      ]}
      title="Team"
    />
  );
}
