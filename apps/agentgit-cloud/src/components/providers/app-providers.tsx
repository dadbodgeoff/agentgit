"use client";

import { useEffect, type ReactNode } from "react";
import * as Sentry from "@sentry/nextjs";
import type { Session } from "next-auth";
import { SessionProvider } from "next-auth/react";

import { WorkspaceProvider } from "@/lib/auth/workspace-context";
import { QueryProvider } from "@/lib/query/provider";
import type { WorkspaceSession } from "@/schemas/cloud";
import { LiveUpdateProvider } from "@/components/providers/live-update-provider";

export function AppProviders({
  children,
  session,
  workspaceSession,
}: {
  children: ReactNode;
  session: Session | null;
  workspaceSession: WorkspaceSession | null;
}) {
  useEffect(() => {
    if (!workspaceSession) {
      Sentry.setUser(null);
      return;
    }

    Sentry.setUser({
      id: workspaceSession.user.id,
      email: workspaceSession.user.email,
      username: workspaceSession.user.name,
    });
    Sentry.setTag("workspace_id", workspaceSession.activeWorkspace.id);
    Sentry.setTag("workspace_role", workspaceSession.activeWorkspace.role);
  }, [workspaceSession]);

  return (
    <SessionProvider session={session}>
      <WorkspaceProvider value={workspaceSession}>
        <QueryProvider>
          <LiveUpdateProvider workspaceSession={workspaceSession}>{children}</LiveUpdateProvider>
        </QueryProvider>
      </WorkspaceProvider>
    </SessionProvider>
  );
}
