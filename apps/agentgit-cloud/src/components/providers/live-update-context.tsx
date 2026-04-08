"use client";

import { createContext, useContext } from "react";

export type LiveUpdateStatus = {
  state: "connecting" | "connected" | "degraded";
  lastInvalidatedAt: string | null;
  invalidationCount: number;
};

const LiveUpdateStatusContext = createContext<LiveUpdateStatus>({
  state: "connecting",
  lastInvalidatedAt: null,
  invalidationCount: 0,
});

export function LiveUpdateStatusProvider({
  children,
  value,
}: {
  children: React.ReactNode;
  value: LiveUpdateStatus;
}) {
  return <LiveUpdateStatusContext.Provider value={value}>{children}</LiveUpdateStatusContext.Provider>;
}

export function useLiveUpdateStatus() {
  return useContext(LiveUpdateStatusContext);
}
