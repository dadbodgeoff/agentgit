import { NextResponse } from "next/server";
import type { Session } from "next-auth";

import { auth } from "@/auth";
import { resolveWorkspaceSession } from "@/lib/auth/workspace-session";
import { hasAtLeastRole } from "@/lib/rbac/roles";
import { enforceApiRateLimits } from "@/lib/security/rate-limit";
import type { WorkspaceRole, WorkspaceSession } from "@/schemas/cloud";

export async function requireApiSession(request?: Request): Promise<
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

  const workspaceSession = await resolveWorkspaceSession(session);

  if (!workspaceSession) {
    return {
      session: null,
      workspaceSession: null,
      unauthorized: NextResponse.json({ message: "Workspace session is unavailable." }, { status: 401 }),
    };
  }

  if (request) {
    const rateLimited = await enforceApiRateLimits(request, workspaceSession.activeWorkspace.id);
    if (rateLimited) {
      return {
        session: null,
        workspaceSession: null,
        unauthorized: rateLimited,
      };
    }
  }

  return {
    session,
    workspaceSession,
    unauthorized: null,
  };
}

export async function requireApiRole(requiredRole: WorkspaceRole, request?: Request): Promise<
  | { session: Session; workspaceSession: WorkspaceSession; denied: null }
  | { session: null; workspaceSession: null; denied: NextResponse }
> {
  const access = await requireApiSession(request);

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
