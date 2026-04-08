"use client";

import { useEffect, useState, type ReactNode } from "react";

import { useQueryClient } from "@tanstack/react-query";

import { queryKeys } from "@/lib/query/keys";
import type { WorkspaceSession } from "@/schemas/cloud";
import { LiveUpdateStatusProvider } from "@/components/providers/live-update-context";

export function LiveUpdateProvider({
  children,
  workspaceSession,
}: {
  children: ReactNode;
  workspaceSession: WorkspaceSession | null;
}) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<"connecting" | "connected" | "degraded">("connecting");
  const [lastInvalidatedAt, setLastInvalidatedAt] = useState<string | null>(null);
  const [invalidationCount, setInvalidationCount] = useState(0);

  useEffect(() => {
    if (!workspaceSession) {
      return;
    }

    setStatus("connecting");
    const source = new EventSource("/api/v1/live/stream");
    const invalidateGovernedQueries = () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.repositories }).catch(() => undefined);
      queryClient.invalidateQueries({ queryKey: ["repository"] }).catch(() => undefined);
      queryClient.invalidateQueries({ queryKey: ["runs"] }).catch(() => undefined);
      queryClient.invalidateQueries({ queryKey: ["run"] }).catch(() => undefined);
      queryClient.invalidateQueries({ queryKey: ["action"] }).catch(() => undefined);
      queryClient.invalidateQueries({ queryKey: ["repository-snapshots"] }).catch(() => undefined);
      queryClient.invalidateQueries({ queryKey: ["repository-policy"] }).catch(() => undefined);
    };
    source.addEventListener("connected", () => {
      setStatus("connected");
    });
    source.addEventListener("invalidate", (event) => {
      setStatus("connected");
      setLastInvalidatedAt(new Date().toISOString());
      setInvalidationCount((current) => current + 1);
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
      if (
        topics.includes("dashboard") ||
        topics.includes("approvals") ||
        topics.includes("activity") ||
        topics.includes("audit") ||
        topics.includes("calibration") ||
        topics.includes("connectors")
      ) {
        invalidateGovernedQueries();
      }
    });
    source.onerror = () => {
      setStatus("degraded");
    };

    return () => {
      source.close();
    };
  }, [queryClient, workspaceSession]);

  return (
    <LiveUpdateStatusProvider
      value={{
        state: status,
        lastInvalidatedAt,
        invalidationCount,
      }}
    >
      {children}
    </LiveUpdateStatusProvider>
  );
}
