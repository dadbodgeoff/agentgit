"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useWorkspace } from "@/lib/auth/workspace-context";
import { authenticatedRoutes } from "@/lib/navigation/routes";
import { hasAtLeastRole } from "@/lib/rbac/roles";
import { cn } from "@/lib/utils/cn";

const navItems = [
  { href: authenticatedRoutes.dashboard, label: "Dashboard", minRole: "member" as const },
  { href: authenticatedRoutes.repositories, label: "Repositories", minRole: "member" as const },
  { href: authenticatedRoutes.approvals, label: "Approvals", minRole: "member" as const },
  { href: authenticatedRoutes.activity, label: "Activity", minRole: "member" as const },
  { href: authenticatedRoutes.audit, label: "Audit log", minRole: "member" as const },
  { href: authenticatedRoutes.calibration, label: "Calibration", minRole: "admin" as const },
  { href: authenticatedRoutes.connectors, label: "Connectors", minRole: "admin" as const },
  { href: authenticatedRoutes.settings, label: "Settings", minRole: "admin" as const },
];

export function ShellSidebar() {
  const { activeWorkspace } = useWorkspace();
  const pathname = usePathname();
  const visibleItems = navItems.filter((item) => hasAtLeastRole(activeWorkspace.role, item.minRole));

  return (
    <aside className="sticky top-12 hidden h-[calc(100vh-48px)] w-60 shrink-0 border-r border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-3 py-4 lg:block">
      <div className="mb-4 flex h-12 items-center rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] px-3 text-sm text-[var(--ag-text-secondary)]">
        {activeWorkspace.name}
      </div>
      <nav className="space-y-1">
        {visibleItems.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);

          return (
            <Link
              className={cn(
                "ag-focus-ring flex min-h-9 items-center rounded-[var(--ag-radius-md)] border-l-2 px-3 text-sm transition-colors",
                active
                  ? "border-l-[var(--ag-color-brand)] bg-[var(--ag-bg-hover)] text-[var(--ag-text-primary)]"
                  : "border-l-transparent text-[var(--ag-text-secondary)] hover:bg-[var(--ag-bg-hover)] hover:text-[var(--ag-text-primary)]",
              )}
              href={item.href}
              key={item.href}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
