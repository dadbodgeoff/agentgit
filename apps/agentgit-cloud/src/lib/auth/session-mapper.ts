import type { Session } from "next-auth";

import { WorkspaceSessionSchema, type WorkspaceSession } from "@/schemas/cloud";

export function toWorkspaceSession(session: Session | null): WorkspaceSession | null {
  if (!session?.user) {
    return null;
  }

  const parsed = WorkspaceSessionSchema.safeParse({
    user: {
      id: session.user.id ?? session.user.email ?? "user_unknown",
      name: session.user.name ?? "Workspace user",
      email: session.user.email,
    },
    activeWorkspace: session.activeWorkspace,
  });

  return parsed.success ? parsed.data : null;
}
