import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { AccessDeniedState } from "@/components/feedback";
import { publicRoutes } from "@/lib/navigation/routes";
import { getRoleAccess } from "@/lib/rbac/access";

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const access = await getRoleAccess("admin");

  if (!access.session) {
    redirect(publicRoutes.signIn);
  }

  if (!access.allowed) {
    return (
      <AccessDeniedState
        currentRole={access.session.activeWorkspace.role}
        requiredRole={access.requiredRole}
        resourceLabel="workspace settings"
      />
    );
  }

  return children;
}
