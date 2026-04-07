"use client";

import Link from "next/link";

import { Button } from "@/components/primitives";
import { useWorkspace } from "@/lib/auth/workspace-context";
import { authenticatedRoutes } from "@/lib/navigation/routes";

export function ShellHeader() {
  const { activeWorkspace, user } = useWorkspace();

  return (
    <header className="sticky top-0 z-[var(--ag-z-sticky)] border-b border-[var(--ag-border-subtle)] bg-[color:rgb(18_24_32_/_0.92)] backdrop-blur">
      <div className="mx-auto flex h-12 max-w-[1600px] items-center justify-between gap-4 px-4 md:px-6">
        <div className="flex items-center gap-4">
          <Link className="text-sm font-semibold tracking-[-0.02em]" href={authenticatedRoutes.dashboard}>
            <span className="text-[var(--ag-text-primary)]">Agent</span>
            <span className="text-[var(--ag-color-brand)]">Git</span>
          </Link>
          <span className="hidden text-xs text-[var(--ag-text-tertiary)] md:inline">Workspace / repo / run detail</span>
        </div>
        <div className="hidden min-w-[240px] flex-1 justify-center md:flex">
          <button className="ag-focus-ring flex h-9 w-full max-w-[560px] items-center justify-between rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] bg-[var(--ag-bg-card)] px-3 text-sm text-[var(--ag-text-secondary)]">
            <span>Search everything</span>
            <span className="font-mono text-xs">Cmd+K</span>
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden text-xs text-[var(--ag-text-tertiary)] lg:inline">
            {activeWorkspace.name} · {user.name}
          </span>
          <Button size="sm" variant="ghost">
            Notifications
          </Button>
          <Button size="sm" variant="secondary">
            Settings
          </Button>
        </div>
      </div>
    </header>
  );
}
