import type { DefaultSession } from "next-auth";
import type { JWT as DefaultJWT } from "next-auth/jwt";

import type { ActiveWorkspace, WorkspaceRole } from "@/schemas/cloud";

declare module "next-auth" {
  interface Session {
    activeWorkspace: ActiveWorkspace;
    user: DefaultSession["user"] & {
      id: string;
      role: WorkspaceRole;
    };
  }

  interface User {
    activeWorkspace?: ActiveWorkspace;
    role?: WorkspaceRole;
  }
}

declare module "next-auth/jwt" {
  interface JWT extends DefaultJWT {
    activeWorkspace?: ActiveWorkspace;
    role?: WorkspaceRole;
  }
}
