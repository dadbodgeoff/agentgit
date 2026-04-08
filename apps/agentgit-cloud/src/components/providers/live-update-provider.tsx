"use client";

import { useEffect, useState, type ReactNode } from "react";

import { useQueryClient } from "@tanstack/react-query";

import { queryKeys } from "@/lib/query/keys";
import type { WorkspaceSession } from "@/schemas/cloud";
import { LiveUpdateStatusProvider } from "@/components/providers/live-update-context";

function parseLiveUpdateTopics(
  workspaceId: string,
  rawData: string,
): {
  topics: string[];
  valid: boolean;
} {
  try {
    const parsed = JSON.parse(rawData) as { topics?: string[]; workspaceId?: string };
    if (parsed.workspaceId !== workspaceId || !Array.isArray(parsed.topics)) {
      return {
        topics: [],
        valid: false,
      };
    }

    return {
      topics: parsed.topics.filter((topic) => typeof topic === "string"),
      valid: true,
    };
  } catch {
    return {
      topics: [],
      valid: false,
    };
  }
}

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
      setStatus("connecting");
      setLastInvalidatedAt(null);
      setInvalidationCount(0);
      return;
    }

    const workspaceId = workspaceSession.activeWorkspace.id;
    setStatus("connecting");
    setLastInvalidatedAt(null);
    setInvalidationCount(0);
    const source = new EventSource(`/api/v1/live/stream?workspaceId=${encodeURIComponent(workspaceId)}`);
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
      const parsed = parseLiveUpdateTopics(workspaceId, (event as MessageEvent<string>).data);
      if (!parsed.valid) {
        setStatus("degraded");
        return;
      }

      setLastInvalidatedAt(new Date().toISOString());
      setInvalidationCount((current) => current + 1);
      const topics = parsed.topics;
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
