"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export type ToastTone = "success" | "info" | "warning" | "error";

export type AppToast = {
  id: string;
  title: string;
  description?: string;
  tone?: ToastTone;
  actionLabel?: string;
  onAction?: () => void;
};

type ToastContextValue = {
  dismissToast: (id: string) => void;
  pushToast: (toast: Omit<AppToast, "id">) => string;
  toasts: AppToast[];
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<AppToast[]>([]);
  const idRef = useRef(0);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback((toast: Omit<AppToast, "id">) => {
    idRef.current += 1;
    const id = `toast-${idRef.current}`;
    setToasts((current): AppToast[] => [{ id, tone: "info" as const, ...toast }, ...current].slice(0, 3));
    return id;
  }, []);

  useEffect(() => {
    const timers = toasts
      .filter((toast) => toast.tone !== "error")
      .map((toast) =>
        window.setTimeout(() => {
          dismissToast(toast.id);
        }, 5000),
      );

    return () => {
      for (const timer of timers) {
        window.clearTimeout(timer);
      }
    };
  }, [dismissToast, toasts]);

  const value = useMemo(
    () => ({
      dismissToast,
      pushToast,
      toasts,
    }),
    [dismissToast, pushToast, toasts],
  );

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
}

export function useToast() {
  const context = useContext(ToastContext);

  if (!context) {
    throw new Error("useToast must be used within a toast provider.");
  }

  return context;
}

export function useOptionalToast() {
  return useContext(ToastContext);
}
