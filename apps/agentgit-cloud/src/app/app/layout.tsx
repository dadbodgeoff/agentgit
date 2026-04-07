import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { AppProviders } from "@/components/providers/app-providers";
import { AppShell } from "@/components/shell/app-shell";
import { resolveWorkspaceSession } from "@/lib/auth/workspace-session";
import { authenticatedRoutes, publicRoutes } from "@/lib/navigation/routes";

export default async function AuthenticatedLayout({ children }: { children: ReactNode }) {
  const session = await auth();

  if (!session) {
    redirect(`${publicRoutes.signIn}?callbackUrl=${encodeURIComponent(authenticatedRoutes.dashboard)}`);
  }

  const workspaceSession = resolveWorkspaceSession(session);
  if (!workspaceSession) {
    redirect(`${publicRoutes.signIn}?callbackUrl=${encodeURIComponent(authenticatedRoutes.dashboard)}&error=AccessDenied`);
  }

  return (
    <AppProviders session={session} workspaceSession={workspaceSession}>
      <AppShell>{children}</AppShell>
    </AppProviders>
  );
}
