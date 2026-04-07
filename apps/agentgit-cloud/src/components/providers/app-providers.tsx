import type { ReactNode } from "react";

import { WorkspaceProvider } from "@/lib/auth/workspace-context";
import { QueryProvider } from "@/lib/query/provider";

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <WorkspaceProvider>
      <QueryProvider>{children}</QueryProvider>
    </WorkspaceProvider>
  );
}
