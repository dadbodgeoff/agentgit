"use client";

import { createContext, useContext, type ReactNode } from "react";

import { WorkspaceSessionSchema, type WorkspaceSession } from "@/schemas/cloud";

const defaultWorkspaceSession = WorkspaceSessionSchema.parse({
  user: {
    id: "user_jsmith",
    name: "Jordan Smith",
    email: "jordan@acme.dev",
  },
  activeWorkspace: {
    id: "ws_acme_01",
    name: "Acme platform",
    slug: "acme-platform",
    role: "admin",
  },
});

const WorkspaceContext = createContext<WorkspaceSession>(defaultWorkspaceSession);

export function WorkspaceProvider({
  children,
  value = defaultWorkspaceSession,
}: {
  children: ReactNode;
  value?: WorkspaceSession;
}): JSX.Element {
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceSession {
  return useContext(WorkspaceContext);
}
