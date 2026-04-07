"use client";

import Link from "next/link";
import { signOut } from "next-auth/react";

import { Button } from "@/components/primitives";
import { useWorkspace } from "@/lib/auth/workspace-context";
import { authenticatedRoutes, publicRoutes } from "@/lib/navigation/routes";
import { hasAtLeastRole } from "@/lib/rbac/roles";

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
            {activeWorkspace.name} · {user.name} · {activeWorkspace.role}
          </span>
          <Button size="sm" variant="ghost">
            Notifications
          </Button>
          {hasAtLeastRole(activeWorkspace.role, "admin") ? (
            <Link
              className="ag-focus-ring inline-flex h-8 items-center justify-center rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] px-3 text-[13px] font-medium text-[var(--ag-text-primary)] transition-colors hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-hover)]"
              href={authenticatedRoutes.settings}
            >
              Settings
            </Link>
          ) : null}
          <Button
            onClick={() => void signOut({ redirectTo: publicRoutes.signIn })}
            size="sm"
            variant="ghost"
          >
            Sign out
          </Button>
        </div>
      </div>
    </header>
  );
}
