"use client";

import { useEffect, type ReactNode } from "react";
import * as Sentry from "@sentry/nextjs";
import type { Session } from "next-auth";
import { SessionProvider } from "next-auth/react";

import { WorkspaceProvider } from "@/lib/auth/workspace-context";
import { QueryProvider } from "@/lib/query/provider";
import type { WorkspaceSession } from "@/schemas/cloud";
import { LiveUpdateProvider } from "@/components/providers/live-update-provider";
import { ToastProvider } from "@/components/providers/toast-provider";

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
      Sentry.setTag("workspace_role", null);
      Sentry.setTag("auth_state", "anonymous");
      return;
    }

    Sentry.setUser(null);
    Sentry.setTag("auth_state", "authenticated");
    Sentry.setTag("workspace_role", workspaceSession.activeWorkspace.role);
  }, [workspaceSession]);

  return (
    <SessionProvider session={session}>
      <WorkspaceProvider value={workspaceSession}>
        <QueryProvider>
          <ToastProvider>
            <LiveUpdateProvider workspaceSession={workspaceSession}>{children}</LiveUpdateProvider>
          </ToastProvider>
        </QueryProvider>
      </WorkspaceProvider>
    </SessionProvider>
  );
}
