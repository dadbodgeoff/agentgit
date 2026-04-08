"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  CreditCard,
  GitFork,
  LayoutDashboard,
  LogOut,
  Plug,
  Radio,
  Rocket,
  ScrollText,
  Search,
  Settings,
  ShieldCheck,
  Sliders,
  Users,
  type LucideIcon,
} from "lucide-react";
import { signOut } from "next-auth/react";

import { useCommandPalette } from "@/components/shell/command-palette-context";
import { authenticatedRoutes, publicRoutes } from "@/lib/navigation/routes";
import { cn } from "@/lib/utils/cn";

interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  category: "Navigation" | "Actions";
  icon: LucideIcon;
  action: () => void;
}

export function CommandPalette() {
  const router = useRouter();
  const { open, setOpen } = useCommandPalette();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const items = useMemo<CommandItem[]>(
    () => [
      { id: "nav-dashboard", label: "Dashboard", category: "Navigation", icon: LayoutDashboard, action: () => router.push(authenticatedRoutes.dashboard) },
      { id: "nav-repos", label: "Repositories", category: "Navigation", icon: GitFork, action: () => router.push(authenticatedRoutes.repositories) },
      { id: "nav-approvals", label: "Approvals", category: "Navigation", icon: ShieldCheck, action: () => router.push(authenticatedRoutes.approvals) },
      { id: "nav-activity", label: "Activity", category: "Navigation", icon: Activity, action: () => router.push(authenticatedRoutes.activity) },
      { id: "nav-audit", label: "Audit log", category: "Navigation", icon: ScrollText, action: () => router.push(authenticatedRoutes.audit) },
      { id: "nav-calibration", label: "Calibration", category: "Navigation", icon: Sliders, action: () => router.push(authenticatedRoutes.calibration) },
      { id: "nav-connectors", label: "Connectors", category: "Navigation", icon: Radio, action: () => router.push(authenticatedRoutes.connectors) },
      { id: "nav-settings", label: "Settings", category: "Navigation", icon: Settings, action: () => router.push(authenticatedRoutes.settings) },
      { id: "nav-team", label: "Team", hint: "Settings", category: "Navigation", icon: Users, action: () => router.push(authenticatedRoutes.team) },
      { id: "nav-billing", label: "Billing", hint: "Settings", category: "Navigation", icon: CreditCard, action: () => router.push(authenticatedRoutes.billing) },
      { id: "nav-integrations", label: "Integrations", hint: "Settings", category: "Navigation", icon: Plug, action: () => router.push(authenticatedRoutes.integrations) },
      { id: "nav-onboarding", label: "Onboarding", category: "Navigation", icon: Rocket, action: () => router.push(authenticatedRoutes.onboarding) },
      { id: "action-sign-out", label: "Sign out", category: "Actions", icon: LogOut, action: () => void signOut({ redirectTo: publicRoutes.signIn }) },
    ],
    [router],
  );

  const filtered = useMemo(() => {
    if (!query.trim()) return items;
    const lower = query.toLowerCase();
    return items.filter(
      (item) =>
        item.label.toLowerCase().includes(lower) ||
        item.category.toLowerCase().includes(lower) ||
        (item.hint?.toLowerCase().includes(lower) ?? false),
    );
  }, [items, query]);

  // Reset when opened, close when closed
  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  // Reset selection when filter changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const activate = useCallback(
    (item: CommandItem) => {
      setOpen(false);
      // Defer so the overlay unmounts before navigation
      setTimeout(() => item.action(), 0);
    },
    [setOpen],
  );

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((idx) => Math.min(idx + 1, filtered.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((idx) => Math.max(idx - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = filtered[selectedIndex];
      if (item) activate(item);
    }
  };

  if (!open) return null;

  // Group filtered results by category
  const grouped: Record<string, CommandItem[]> = {};
  filtered.forEach((item) => {
    if (!grouped[item.category]) grouped[item.category] = [];
    grouped[item.category].push(item);
  });

  let flatIndex = -1;

  return (
    <div
      className="fixed inset-0 z-[var(--ag-z-modal)] flex items-start justify-center bg-black/60 p-6 pt-[10vh] backdrop-blur-sm"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-[560px] overflow-hidden rounded-[var(--ag-radius-xl)] border border-[var(--ag-border-default)] bg-[var(--ag-bg-card)] shadow-[var(--ag-shadow-xl)]"
        onClick={(event) => event.stopPropagation()}
      >
        {/* Input */}
        <div className="flex items-center gap-3 border-b border-[var(--ag-border-subtle)] px-4 py-3">
          <Search aria-hidden="true" className="text-[var(--ag-text-tertiary)]" size={18} strokeWidth={1.5} />
          <input
            aria-autocomplete="list"
            aria-controls="command-palette-list"
            aria-expanded={true}
            className="flex-1 border-0 bg-transparent text-[15px] text-[var(--ag-text-primary)] placeholder:text-[var(--ag-text-tertiary)] focus:outline-none"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a command or search..."
            ref={inputRef}
            role="combobox"
            type="text"
            value={query}
          />
          <kbd className="hidden rounded-[var(--ag-radius-sm)] border border-[var(--ag-border-default)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--ag-text-tertiary)] sm:inline">
            Esc
          </kbd>
        </div>

        {/* Results */}
        <ul
          className="max-h-[400px] overflow-y-auto p-2"
          id="command-palette-list"
          ref={listRef}
          role="listbox"
        >
          {filtered.length === 0 ? (
            <li className="px-4 py-6 text-center text-[13px] text-[var(--ag-text-tertiary)]">
              No results found. Try a different search term.
            </li>
          ) : (
            Object.entries(grouped).map(([category, categoryItems]) => (
              <li key={category}>
                <div className="px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-[var(--ag-text-tertiary)]">
                  {category}
                </div>
                <ul>
                  {categoryItems.map((item) => {
                    flatIndex += 1;
                    const index = flatIndex;
                    const isSelected = index === selectedIndex;
                    const Icon = item.icon;
                    return (
                      <li
                        aria-selected={isSelected}
                        className={cn(
                          "flex cursor-pointer items-center gap-3 rounded-[var(--ag-radius-md)] px-3 py-2 text-[13px] transition-colors",
                          isSelected
                            ? "bg-[var(--ag-bg-hover)] text-[var(--ag-text-primary)]"
                            : "text-[var(--ag-text-secondary)] hover:bg-[var(--ag-bg-hover)] hover:text-[var(--ag-text-primary)]",
                        )}
                        key={item.id}
                        onClick={() => activate(item)}
                        onMouseEnter={() => setSelectedIndex(index)}
                        role="option"
                      >
                        <Icon size={16} strokeWidth={1.5} />
                        <span className="flex-1">{item.label}</span>
                        {item.hint ? (
                          <span className="text-[11px] text-[var(--ag-text-tertiary)]">{item.hint}</span>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))
          )}
        </ul>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-2 text-[11px] text-[var(--ag-text-tertiary)]">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <kbd className="rounded-[var(--ag-radius-sm)] border border-[var(--ag-border-default)] px-1 py-0.5 font-mono">↑↓</kbd>
              Navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="rounded-[var(--ag-radius-sm)] border border-[var(--ag-border-default)] px-1 py-0.5 font-mono">↵</kbd>
              Select
            </span>
          </div>
          <span className="font-mono">⌘K</span>
        </div>
      </div>
    </div>
  );
}
