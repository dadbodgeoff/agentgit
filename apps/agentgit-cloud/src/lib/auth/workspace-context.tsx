"use client";

import { createContext, useContext, type ReactNode } from "react";
import { useSession } from "next-auth/react";

import { toWorkspaceSession } from "@/lib/auth/session-mapper";
import type { WorkspaceSession } from "@/schemas/cloud";

const WorkspaceContext = createContext<WorkspaceSession | null>(null);

export function WorkspaceProvider({
  children,
  value = null,
}: {
  children: ReactNode;
  value?: WorkspaceSession | null;
}) {
  const { data } = useSession();
  const derivedValue = toWorkspaceSession(data);

  return <WorkspaceContext.Provider value={value ?? derivedValue}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceSession {
  const context = useContext(WorkspaceContext);

  if (!context) {
    throw new Error("useWorkspace must be used within an authenticated workspace provider.");
  }

  return context;
}
