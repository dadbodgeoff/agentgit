"use client";

import { useEffect, useState, type ReactNode } from "react";

import { ToastViewport } from "@/components/primitives";
import { CommandPalette } from "@/components/shell/command-palette";
import { ShellHeader } from "@/components/shell/shell-header";
import { ShellSidebar } from "@/components/shell/shell-sidebar";

export function AppShell({ children }: { children: ReactNode }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);

  useEffect(() => {
    function syncResponsiveShell() {
      if (window.innerWidth < 640) {
        setMobileNavOpen(false);
        return;
      }

      setSidebarCollapsed(window.innerWidth < 1024);
    }

    syncResponsiveShell();
    window.addEventListener("resize", syncResponsiveShell);
    return () => window.removeEventListener("resize", syncResponsiveShell);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandPaletteOpen((current) => !current);
      } else if (event.key === "[" && window.innerWidth >= 640) {
        event.preventDefault();
        setSidebarCollapsed((current) => !current);
      } else if (event.key === "Escape") {
        setCommandPaletteOpen(false);
        setMobileNavOpen(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="ag-page-shell min-h-screen">
      <a className="ag-skip-link ag-focus-ring" href="#main-content">
        Skip to content
      </a>
      <ShellHeader
        onOpenCommandPalette={() => setCommandPaletteOpen(true)}
        onOpenMobileNav={() => setMobileNavOpen(true)}
        onToggleSidebar={() => setSidebarCollapsed((current) => !current)}
        sidebarCollapsed={sidebarCollapsed}
      />
      <div className="mx-auto flex w-full max-w-[1600px]">
        <ShellSidebar
          collapsed={sidebarCollapsed}
          mobileOpen={mobileNavOpen}
          onCloseMobile={() => setMobileNavOpen(false)}
          onToggleCollapsed={() => setSidebarCollapsed((current) => !current)}
        />
        <main className="min-h-[calc(100vh-48px)] flex-1 px-4 pb-10 pt-6 sm:px-6 lg:px-8 lg:pt-8" id="main-content">
          <div className="mx-auto flex max-w-[1200px] flex-col gap-10">{children}</div>
        </main>
      </div>
      <CommandPalette onClose={() => setCommandPaletteOpen(false)} open={commandPaletteOpen} />
      <ToastViewport />
    </div>
  );
}
