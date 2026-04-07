import { NextResponse } from "next/server";
import type { Session } from "next-auth";

import { auth } from "@/auth";
import { resolveWorkspaceSession } from "@/lib/auth/workspace-session";
import { hasAtLeastRole } from "@/lib/rbac/roles";
import type { WorkspaceRole, WorkspaceSession } from "@/schemas/cloud";

export async function requireApiSession(): Promise<
  | { session: Session; workspaceSession: WorkspaceSession; unauthorized: null }
  | { session: null; workspaceSession: null; unauthorized: NextResponse }
> {
  const session = await auth();

  if (!session) {
    return {
      session: null,
      workspaceSession: null,
      unauthorized: NextResponse.json({ message: "Unauthorized." }, { status: 401 }),
    };
  }

  const workspaceSession = resolveWorkspaceSession(session);

  if (!workspaceSession) {
    return {
      session: null,
      workspaceSession: null,
      unauthorized: NextResponse.json({ message: "Workspace session is unavailable." }, { status: 401 }),
    };
  }

  return {
    session,
    workspaceSession,
    unauthorized: null,
  };
}

export async function requireApiRole(requiredRole: WorkspaceRole): Promise<
  | { session: Session; workspaceSession: WorkspaceSession; denied: null }
  | { session: null; workspaceSession: null; denied: NextResponse }
> {
  const access = await requireApiSession();

  if (access.unauthorized || !access.session) {
    return {
      session: null,
      workspaceSession: null,
      denied: access.unauthorized,
    };
  }

  if (!hasAtLeastRole(access.workspaceSession.activeWorkspace.role, requiredRole)) {
    return {
      session: null,
      workspaceSession: null,
      denied: NextResponse.json({ message: "Forbidden." }, { status: 403 }),
    };
  }

  return {
    session: access.session,
    workspaceSession: access.workspaceSession,
    denied: null,
  };
}
