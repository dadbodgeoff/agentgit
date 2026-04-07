import { ScaffoldPage } from "@/features/shared/scaffold-page";

export default function AuditRoute(): JSX.Element {
  return (
    <ScaffoldPage
      description="Workspace audit log scaffold with read-only filtering and export surface."
      sections={[
        { title: "Audit table", description: "Timestamp, actor, action type, target, IP, and outcome.", kind: "table" },
        { title: "Export flow", description: "CSV export and admin-only access handling.", kind: "status" },
      ]}
      title="Audit log"
    />
  );
}
