import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { AccessDeniedState } from "@/components/feedback";
import { publicRoutes } from "@/lib/navigation/routes";
import { getRoleAccess } from "@/lib/rbac/access";

export default async function BillingSettingsLayout({ children }: { children: ReactNode }) {
  const access = await getRoleAccess("owner");

  if (!access.session) {
    redirect(publicRoutes.signIn);
  }

  if (!access.allowed) {
    return (
      <AccessDeniedState
        currentRole={access.session.activeWorkspace.role}
        requiredRole={access.requiredRole}
        resourceLabel="billing settings"
      />
    );
  }

  return children;
}
