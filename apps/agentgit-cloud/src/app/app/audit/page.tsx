import { AccessDeniedState } from "@/components/feedback";
import { AuditPage } from "@/features/audit/audit-page";
import { getRoleAccess } from "@/lib/rbac/access";

export default async function AuditRoute() {
  const access = await getRoleAccess("admin");

  if (!access.session) {
    return null;
  }

  if (!access.allowed) {
    return (
      <AccessDeniedState
        currentRole={access.session.activeWorkspace.role}
        requiredRole={access.requiredRole}
        resourceLabel="the audit log"
      />
    );
  }

  return <AuditPage />;
}
