"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, ChevronRight, Menu, PanelLeft, Search, Settings } from "lucide-react";

import { Button } from "@/components/primitives";
import { useWorkspace } from "@/lib/auth/workspace-context";
import { authenticatedRoutes } from "@/lib/navigation/routes";
import { hasAtLeastRole } from "@/lib/rbac/roles";

function deriveBreadcrumbs(pathname: string): Array<{ href: string; label: string }> {
  if (pathname === authenticatedRoutes.dashboard) {
    return [{ href: authenticatedRoutes.dashboard, label: "Dashboard" }];
  }

  // /app/repos itself (no owner/name) — fall into the repo list label.
  if (pathname === authenticatedRoutes.repositories) {
    return [{ href: authenticatedRoutes.repositories, label: "Repositories" }];
  }

  if (pathname.startsWith("/app/repos/")) {
    const segments = pathname.split("/");
    const owner = segments[3];
    const name = segments[4];
    const section = segments[5];
    const detail = segments[6];
    const extra = segments[7];
    const repoLabel = owner && name ? `${owner}/${name}` : "Repository";
    const crumbs = [
      { href: authenticatedRoutes.repositories, label: "Repositories" },
      { href: `/app/repos/${owner}/${name}`, label: repoLabel },
    ];

    if (section === "runs" && detail && extra === "actions") {
      return [...crumbs, { href: pathname, label: "Action detail" }];
    }

    if (section === "runs" && detail) {
      return [...crumbs, { href: pathname, label: "Run detail" }];
    }

    if (section === "runs") {
      return [...crumbs, { href: pathname, label: "Runs" }];
    }

    if (section === "policy") {
      return [...crumbs, { href: pathname, label: "Policy" }];
    }

    if (section === "snapshots") {
      return [...crumbs, { href: pathname, label: "Snapshots" }];
    }

    return crumbs;
  }

  const staticLabels: Record<string, string> = {
    [authenticatedRoutes.approvals]: "Approvals",
    [authenticatedRoutes.activity]: "Activity",
    [authenticatedRoutes.audit]: "Audit log",
    [authenticatedRoutes.calibration]: "Calibration",
    [authenticatedRoutes.connectors]: "Connectors",
    [authenticatedRoutes.settings]: "Workspace settings",
    [authenticatedRoutes.team]: "Team settings",
    [authenticatedRoutes.billing]: "Billing",
    [authenticatedRoutes.integrations]: "Integrations",
    [authenticatedRoutes.onboarding]: "Onboarding",
  };

  return [{ href: pathname, label: staticLabels[pathname] ?? "Workspace" }];
}

export function ShellHeader({
  onOpenCommandPalette,
  onOpenMobileNav,
  onToggleSidebar,
  sidebarCollapsed,
}: {
  onOpenCommandPalette: () => void;
  onOpenMobileNav: () => void;
  onToggleSidebar: () => void;
  sidebarCollapsed: boolean;
}) {
  const { activeWorkspace, user } = useWorkspace();
  const pathname = usePathname();
  const breadcrumbs = deriveBreadcrumbs(pathname);
  const mobileBackCrumb = breadcrumbs.length > 1 ? breadcrumbs[breadcrumbs.length - 2] : null;
  const avatarLabel = user.name
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <header className="sticky top-0 z-[var(--ag-z-sticky)] border-b border-[var(--ag-border-subtle)] bg-[color:rgb(18_24_32_/_0.92)] backdrop-blur">
      <div className="mx-auto flex h-12 max-w-[1600px] items-center justify-between gap-3 px-4">
        <div className="flex min-w-0 items-center gap-3">
          <Button className="sm:hidden" onClick={onOpenMobileNav} size="sm" variant="ghost">
            <Menu className="size-4" strokeWidth={1.75} />
          </Button>
          <Button className="hidden sm:inline-flex" onClick={onToggleSidebar} size="sm" variant="ghost">
            <PanelLeft className="size-4" strokeWidth={1.75} />
            {!sidebarCollapsed ? "Collapse" : "Expand"}
          </Button>
          <Link className="ag-text-body-sm font-semibold tracking-[-0.02em]" href={authenticatedRoutes.dashboard}>
            <span className="text-[var(--ag-text-primary)]">Agent</span>
            <span className="text-[var(--ag-color-brand)]">Git</span>
          </Link>
          {mobileBackCrumb ? (
            <Link className="ag-text-body-sm text-[var(--ag-text-secondary)] sm:hidden" href={mobileBackCrumb.href}>
              {mobileBackCrumb.label}
            </Link>
          ) : null}
          <nav className="hidden min-w-0 items-center gap-2 sm:flex">
            {breadcrumbs.slice(-3).map((crumb, index) => (
              <span className="flex min-w-0 items-center gap-2" key={`${crumb.href}-${crumb.label}`}>
                {index > 0 ? (
                  <ChevronRight className="size-4 shrink-0 text-[var(--ag-text-tertiary)]" strokeWidth={1.75} />
                ) : null}
                <Link
                  className={
                    index === breadcrumbs.slice(-3).length - 1
                      ? "truncate ag-text-body-sm text-[var(--ag-text-primary)]"
                      : "truncate ag-text-body-sm text-[var(--ag-text-secondary)] hover:text-[var(--ag-text-primary)]"
                  }
                  href={crumb.href}
                >
                  {crumb.label}
                </Link>
              </span>
            ))}
          </nav>
        </div>
        <div className="hidden min-w-[240px] flex-1 justify-center md:flex">
          <button
            className="ag-focus-ring flex min-h-11 w-full max-w-[560px] items-center justify-between rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] bg-[var(--ag-surface-overlay)] px-3 ag-text-body-sm text-[var(--ag-text-secondary)]"
            onClick={onOpenCommandPalette}
            type="button"
          >
            <span className="flex items-center gap-2">
              <Search className="size-4" strokeWidth={1.75} />
              Search everything
            </span>
            <span className="ag-text-code text-[var(--ag-text-tertiary)]">Cmd+K</span>
          </button>
        </div>
        <div className="flex items-center gap-2">
          <Button
            aria-label="Open command palette"
            className="md:hidden"
            onClick={onOpenCommandPalette}
            size="sm"
            variant="ghost"
          >
            <Search className="size-4" strokeWidth={1.75} />
          </Button>
          <Button aria-label="Notifications" size="sm" variant="ghost">
            <Bell className="size-4" strokeWidth={1.75} />
          </Button>
          {hasAtLeastRole(activeWorkspace.role, "admin") ? (
            <Link
              aria-label="Settings"
              className="ag-focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] px-3 text-[var(--ag-text-primary)] transition-colors hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-hover)]"
              href={authenticatedRoutes.settings}
            >
              <Settings className="size-4" strokeWidth={1.75} />
              <span className="hidden lg:inline">Settings</span>
            </Link>
          ) : null}
          <div className="hidden items-center gap-3 rounded-[var(--ag-radius-full)] border border-[var(--ag-border-default)] bg-[var(--ag-surface-overlay)] px-2 py-1 sm:flex">
            <span className="text-right">
              <span className="block ag-text-caption text-[var(--ag-text-tertiary)]">{activeWorkspace.name}</span>
              <span className="block ag-text-body-sm text-[var(--ag-text-primary)]">{user.name}</span>
            </span>
            <span className="inline-flex size-8 items-center justify-center rounded-full bg-[color:rgb(10_205_207_/_0.16)] ag-text-body-sm font-semibold text-[var(--ag-color-brand)]">
              {avatarLabel}
            </span>
          </div>
          <div className="inline-flex size-9 items-center justify-center rounded-full border border-[var(--ag-border-default)] bg-[var(--ag-surface-overlay)] ag-text-body-sm font-semibold text-[var(--ag-color-brand)] sm:hidden">
            {avatarLabel}
          </div>
        </div>
      </div>
    </header>
  );
}
