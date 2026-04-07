"use client";

import Link from "next/link";

import { useWorkspace } from "@/lib/auth/workspace-context";
import { cn } from "@/lib/utils/cn";

const navItems = [
  { href: "/app", label: "Dashboard", active: true },
  { href: "/app/repos", label: "Repositories" },
  { href: "/app/approvals", label: "Approvals" },
  { href: "/app/activity", label: "Activity" },
  { href: "/app/audit", label: "Audit log" },
  { href: "/app/calibration", label: "Calibration" },
  { href: "/app/settings", label: "Settings" },
];

export function ShellSidebar(): JSX.Element {
  const { activeWorkspace } = useWorkspace();

  return (
    <aside className="sticky top-12 hidden h-[calc(100vh-48px)] w-60 shrink-0 border-r border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-3 py-4 lg:block">
      <div className="mb-4 flex h-12 items-center rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] px-3 text-sm text-[var(--ag-text-secondary)]">
        {activeWorkspace.name}
      </div>
      <nav className="space-y-1">
        {navItems.map((item) => (
          <Link
            className={cn(
              "ag-focus-ring flex min-h-9 items-center rounded-[var(--ag-radius-md)] border-l-2 px-3 text-sm transition-colors",
              item.active
                ? "border-l-[var(--ag-color-brand)] bg-[var(--ag-bg-hover)] text-[var(--ag-text-primary)]"
                : "border-l-transparent text-[var(--ag-text-secondary)] hover:bg-[var(--ag-bg-hover)] hover:text-[var(--ag-text-primary)]",
            )}
            href={item.href}
            key={item.href}
          >
            {item.label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
