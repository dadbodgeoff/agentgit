"use client";

import { useEffect, type ReactNode } from "react";

import { useQueryClient } from "@tanstack/react-query";

import { queryKeys } from "@/lib/query/keys";
import type { WorkspaceSession } from "@/schemas/cloud";

export function LiveUpdateProvider({
  children,
  workspaceSession,
}: {
  children: ReactNode;
  workspaceSession: WorkspaceSession | null;
}) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!workspaceSession) {
      return;
    }

    const source = new EventSource("/api/v1/live/stream");
    source.addEventListener("invalidate", (event) => {
      const parsed = JSON.parse((event as MessageEvent<string>).data) as { topics?: string[] };
      const topics = parsed.topics ?? [];
      if (topics.includes("approvals")) {
        queryClient.invalidateQueries({ queryKey: queryKeys.approvals }).catch(() => undefined);
      }
      if (topics.includes("dashboard")) {
        queryClient.invalidateQueries({ queryKey: queryKeys.dashboard }).catch(() => undefined);
      }
      if (topics.includes("calibration")) {
        queryClient.invalidateQueries({ queryKey: ["calibration"] }).catch(() => undefined);
      }
      if (topics.includes("connectors")) {
        queryClient.invalidateQueries({ queryKey: queryKeys.connectors }).catch(() => undefined);
      }
      if (topics.includes("activity")) {
        queryClient.invalidateQueries({ queryKey: queryKeys.activity }).catch(() => undefined);
      }
      if (topics.includes("audit")) {
        queryClient.invalidateQueries({ queryKey: queryKeys.audit }).catch(() => undefined);
      }
    });

    return () => {
      source.close();
    };
  }, [queryClient, workspaceSession]);

  return children;
}
