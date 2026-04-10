"use client";

import { useEffect, useMemo, useState, type ComponentType } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "next-auth/react";
import { ArrowRight, LogOut } from "lucide-react";

import { Button, Input } from "@/components/primitives";
import { appNavigationItems, shellQuickActions } from "@/components/shell/app-navigation";
import { useWorkspace } from "@/lib/auth/workspace-context";
import { publicRoutes } from "@/lib/navigation/routes";
import { hasAtLeastRole } from "@/lib/rbac/roles";
import { cn } from "@/lib/utils/cn";

type CommandItem = {
  category: string;
  href?: string;
  icon: ComponentType<{ className?: string; strokeWidth?: number }>;
  label: string;
  onSelect?: () => void;
};

export function CommandPalette({ onClose, open }: { onClose: () => void; open: boolean }) {
  const router = useRouter();
  const { activeWorkspace } = useWorkspace();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const items = useMemo<CommandItem[]>(() => {
    const visibleNavigation = appNavigationItems
      .filter((item) => hasAtLeastRole(activeWorkspace.role, item.minRole))
      .map((item) => ({
        category: item.section,
        href: item.href,
        icon: item.icon,
        label: item.label,
      }));

    return [
      ...visibleNavigation,
      ...shellQuickActions.map((item) => ({
        category: item.category,
        href: item.href,
        icon: item.icon,
        label: item.label,
      })),
      {
        category: "Actions",
        icon: LogOut,
        label: "Sign out",
        onSelect: () => void signOut({ redirectTo: publicRoutes.signIn }),
      },
    ];
  }, [activeWorkspace.role]);

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return items;
    }

    return items.filter(
      (item) =>
        item.label.toLowerCase().includes(normalizedQuery) || item.category.toLowerCase().includes(normalizedQuery),
    );
  }, [items, query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActiveIndex(0);
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((current) => Math.min(current + 1, Math.max(filteredItems.length - 1, 0)));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((current) => Math.max(current - 1, 0));
      } else if (event.key === "Enter" && filteredItems[activeIndex]) {
        event.preventDefault();
        const activeItem = filteredItems[activeIndex];
        onClose();
        if (activeItem.href) {
          router.push(activeItem.href);
        } else {
          activeItem.onSelect?.();
        }
      } else if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeIndex, filteredItems, onClose, open, router]);

  if (!open) {
    return null;
  }

  const groupedItems = filteredItems.reduce<Record<string, CommandItem[]>>((acc, item) => {
    acc[item.category] ??= [];
    acc[item.category].push(item);
    return acc;
  }, {});

  return (
    <div className="fixed inset-0 z-[var(--ag-z-modal)] flex items-start justify-center bg-black/40 px-4 py-16 sm:py-20">
      <div className="w-full max-w-[560px] rounded-[var(--ag-radius-xl)] border border-[var(--ag-border-default)] bg-[var(--ag-surface-overlay)] shadow-[var(--ag-shadow-xl)]">
        <div className="border-b border-[var(--ag-border-subtle)] p-4">
          <Input
            autoFocus
            id="command-palette-search"
            label="Search navigation and actions"
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            placeholder="Type a page or action"
            value={query}
          />
        </div>
        <div className="max-h-[480px] overflow-auto p-2">
          {filteredItems.length === 0 ? (
            <div className="px-3 py-8 text-center">
              <div className="ag-text-body-sm text-[var(--ag-text-secondary)]">No matching commands.</div>
            </div>
          ) : (
            Object.entries(groupedItems).map(([category, categoryItems]) => (
              <div className="mb-4 last:mb-0" key={category}>
                <div className="px-3 py-2 ag-text-overline text-[var(--ag-text-tertiary)]">{category}</div>
                <div className="space-y-1">
                  {categoryItems.map((item) => {
                    const index = filteredItems.findIndex(
                      (candidate) => candidate.category === item.category && candidate.label === item.label,
                    );
                    const active = index === activeIndex;
                    const Icon = item.icon;

                    return (
                      <button
                        className={cn(
                          "ag-focus-ring flex w-full items-center justify-between gap-3 rounded-[var(--ag-radius-md)] px-3 py-2 text-left transition-colors duration-[var(--ag-duration-fast)]",
                          active ? "bg-[var(--ag-surface-hover)]" : "hover:bg-[var(--ag-surface-hover)]",
                        )}
                        key={`${category}-${item.label}`}
                        onClick={() => {
                          onClose();
                          if (item.href) {
                            router.push(item.href);
                          } else {
                            item.onSelect?.();
                          }
                        }}
                        type="button"
                      >
                        <span className="flex items-center gap-3">
                          <Icon className="size-5 text-[var(--ag-text-secondary)]" strokeWidth={1.5} />
                          <span className="ag-text-body-sm text-[var(--ag-text-primary)]">{item.label}</span>
                        </span>
                        <ArrowRight className="size-4 text-[var(--ag-text-tertiary)]" strokeWidth={1.75} />
                      </button>
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
        <div className="flex items-center justify-between border-t border-[var(--ag-border-subtle)] px-4 py-3">
          <span className="ag-text-caption text-[var(--ag-text-secondary)]">
            Press Enter to run. Press Escape to close.
          </span>
          <Button onClick={onClose} size="sm" variant="ghost">
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
