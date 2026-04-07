import type { ReactNode } from "react";

import { ShellHeader } from "@/components/shell/shell-header";
import { ShellSidebar } from "@/components/shell/shell-sidebar";
import { ToastViewport } from "@/components/primitives";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="ag-page-shell min-h-screen">
      <a className="ag-skip-link ag-focus-ring" href="#main-content">
        Skip to content
      </a>
      <ShellHeader />
      <div className="mx-auto flex max-w-[1600px]">
        <ShellSidebar />
        <main className="min-h-[calc(100vh-48px)] flex-1 px-6 pb-12 pt-8 md:px-8" id="main-content">
          <div className="mx-auto flex max-w-[1200px] flex-col gap-10">{children}</div>
        </main>
      </div>
      <ToastViewport />
    </div>
  );
}
