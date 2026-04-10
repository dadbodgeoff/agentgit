"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { ChevronLeft, ChevronRight, ChevronsUpDown, CircleHelp, LogOut } from "lucide-react";

import { Button, Tooltip } from "@/components/primitives";
import { appNavigationItems } from "@/components/shell/app-navigation";
import { useWorkspace } from "@/lib/auth/workspace-context";
import { publicRoutes } from "@/lib/navigation/routes";
import { hasAtLeastRole } from "@/lib/rbac/roles";
import { cn } from "@/lib/utils/cn";

export function ShellSidebar({
  collapsed,
  mobileOpen,
  onCloseMobile,
  onToggleCollapsed,
}: {
  collapsed: boolean;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  onToggleCollapsed: () => void;
}) {
  const { activeWorkspace } = useWorkspace();
  const pathname = usePathname();
  const visibleItems = appNavigationItems.filter((item) => hasAtLeastRole(activeWorkspace.role, item.minRole));
  const groupedItems = visibleItems.reduce<Record<string, typeof visibleItems>>((acc, item) => {
    acc[item.section] ??= [];
    acc[item.section].push(item);
    return acc;
  }, {});

  return (
    <>
      <aside
        className={cn(
          "sticky top-12 hidden h-[calc(100vh-48px)] shrink-0 border-r border-[var(--ag-border-subtle)] bg-[var(--ag-surface-raised)] px-2 py-4 sm:block",
          collapsed ? "w-16" : "w-60",
        )}
      >
        <div className="flex h-full flex-col">
          <div className="mb-4 flex min-h-12 items-center gap-2 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] px-2">
            <button
              className={cn(
                "ag-focus-ring flex min-h-11 flex-1 items-center gap-2 rounded-[var(--ag-radius-md)] text-left",
                collapsed && "justify-center",
              )}
              type="button"
            >
              <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-[color:rgb(10_205_207_/_0.16)] ag-text-body-sm font-semibold text-[var(--ag-color-brand)]">
                {activeWorkspace.name.slice(0, 1).toUpperCase()}
              </span>
              {!collapsed ? (
                <>
                  <span className="min-w-0 flex-1">
                    <span className="ag-text-overline text-[var(--ag-text-tertiary)]">Workspace</span>
                    <span className="block truncate ag-text-body-sm font-semibold text-[var(--ag-text-primary)]">
                      {activeWorkspace.name}
                    </span>
                  </span>
                  <ChevronsUpDown className="size-4 text-[var(--ag-text-secondary)]" strokeWidth={1.75} />
                </>
              ) : null}
            </button>
            <Button
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={onToggleCollapsed}
              size="sm"
              variant="ghost"
            >
              {collapsed ? (
                <ChevronRight className="size-4" strokeWidth={1.75} />
              ) : (
                <ChevronLeft className="size-4" strokeWidth={1.75} />
              )}
            </Button>
          </div>

          <nav className="flex-1 space-y-4">
            {Object.entries(groupedItems).map(([section, items]) => (
              <div className="space-y-1" key={section}>
                {!collapsed ? (
                  <div className="px-3 ag-text-overline text-[var(--ag-text-tertiary)]">{section}</div>
                ) : null}
                {items.map((item) => {
                  const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                  const Icon = item.icon;
                  const content = (
                    <Link
                      className={cn(
                        "ag-focus-ring flex min-h-9 items-center rounded-[var(--ag-radius-md)] border-l-2 px-3 transition-colors duration-[var(--ag-duration-fast)]",
                        collapsed ? "justify-center px-0" : "gap-2.5",
                        active
                          ? "border-l-[var(--ag-color-brand)] bg-[var(--ag-surface-hover)] text-[var(--ag-text-primary)]"
                          : "border-l-transparent text-[var(--ag-text-secondary)] hover:bg-[var(--ag-surface-hover)] hover:text-[var(--ag-text-primary)]",
                      )}
                      href={item.href}
                    >
                      <Icon className="size-5 shrink-0" strokeWidth={1.5} />
                      {!collapsed ? <span className="ag-text-body-sm">{item.label}</span> : null}
                    </Link>
                  );

                  return collapsed ? (
                    <Tooltip content={item.label} key={item.href}>
                      {content}
                    </Tooltip>
                  ) : (
                    <div key={item.href}>{content}</div>
                  );
                })}
              </div>
            ))}
          </nav>

          <div className="mt-4 space-y-2 border-t border-[var(--ag-border-subtle)] pt-4">
            <Tooltip content="Open help and quickstart">
              <Link
                className={cn(
                  "ag-focus-ring flex min-h-11 items-center rounded-[var(--ag-radius-md)] text-[var(--ag-text-secondary)] transition-colors hover:bg-[var(--ag-surface-hover)] hover:text-[var(--ag-text-primary)]",
                  collapsed ? "justify-center" : "gap-2 px-3",
                )}
                href={publicRoutes.docs}
              >
                <CircleHelp className="size-5 shrink-0" strokeWidth={1.5} />
                {!collapsed ? <span className="ag-text-body-sm">Help</span> : null}
              </Link>
            </Tooltip>
            <div
              className={cn(
                "rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] bg-[var(--ag-surface-overlay)]",
                collapsed ? "px-0 py-2" : "px-3 py-3",
              )}
            >
              <div className={cn("flex items-center", collapsed ? "justify-center" : "gap-3")}>
                <span className="inline-flex size-8 items-center justify-center rounded-full bg-[color:rgb(10_205_207_/_0.16)] ag-text-body-sm font-semibold text-[var(--ag-color-brand)]">
                  {activeWorkspace.name.slice(0, 1).toUpperCase()}
                </span>
                {!collapsed ? (
                  <div className="min-w-0 flex-1">
                    <div className="truncate ag-text-body-sm font-semibold text-[var(--ag-text-primary)]">
                      {activeWorkspace.name}
                    </div>
                    <div className="ag-text-caption capitalize text-[var(--ag-text-secondary)]">
                      {activeWorkspace.role}
                    </div>
                  </div>
                ) : null}
              </div>
              {!collapsed ? (
                <Button
                  className="mt-3 w-full justify-start"
                  onClick={() => void signOut({ redirectTo: publicRoutes.signIn })}
                  size="sm"
                  variant="ghost"
                >
                  <LogOut className="size-4" strokeWidth={1.75} />
                  Sign out
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </aside>

      {mobileOpen ? (
        <div className="fixed inset-0 z-[var(--ag-z-modal-backdrop)] sm:hidden">
          <button
            aria-label="Close navigation"
            className="absolute inset-0 bg-black/50"
            onClick={onCloseMobile}
            type="button"
          />
          <div className="absolute inset-y-0 left-0 w-[min(88vw,320px)] bg-[var(--ag-surface-raised)] p-4 shadow-[var(--ag-shadow-xl)]">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <div className="ag-text-overline text-[var(--ag-text-tertiary)]">Workspace</div>
                <div className="ag-text-body-sm font-semibold text-[var(--ag-text-primary)]">
                  {activeWorkspace.name}
                </div>
              </div>
              <Button onClick={onCloseMobile} size="sm" variant="ghost">
                <ChevronLeft className="size-4" strokeWidth={1.75} />
              </Button>
            </div>
            <div className="space-y-4 overflow-auto pb-6">
              {Object.entries(groupedItems).map(([section, items]) => (
                <div className="space-y-1" key={section}>
                  <div className="px-3 ag-text-overline text-[var(--ag-text-tertiary)]">{section}</div>
                  {items.map((item) => {
                    const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                    const Icon = item.icon;

                    return (
                      <Link
                        className={cn(
                          "ag-focus-ring flex min-h-11 items-center gap-3 rounded-[var(--ag-radius-md)] px-3 transition-colors duration-[var(--ag-duration-fast)]",
                          active
                            ? "bg-[var(--ag-surface-hover)] text-[var(--ag-text-primary)]"
                            : "text-[var(--ag-text-secondary)] hover:bg-[var(--ag-surface-hover)] hover:text-[var(--ag-text-primary)]",
                        )}
                        href={item.href}
                        key={item.href}
                        onClick={onCloseMobile}
                      >
                        <Icon className="size-5 shrink-0" strokeWidth={1.5} />
                        <span className="ag-text-body-sm">{item.label}</span>
                      </Link>
                    );
                  })}
                </div>
              ))}
              <div className="border-t border-[var(--ag-border-subtle)] pt-4">
                <Button
                  className="w-full justify-start"
                  onClick={() => void signOut({ redirectTo: publicRoutes.signIn })}
                  variant="ghost"
                >
                  <LogOut className="size-4" strokeWidth={1.75} />
                  Sign out
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
