import type { ReactNode } from "react";
import Link from "next/link";

import { Badge } from "@/components/primitives";
import { publicRoutes } from "@/lib/navigation/routes";
import { cn } from "@/lib/utils/cn";

export const marketingLinkClasses = {
  primary:
    "ag-focus-ring inline-flex min-h-11 items-center justify-center rounded-[var(--ag-radius-md)] border border-transparent bg-[var(--ag-color-brand)] px-5 text-[14px] font-medium text-[#0b0f14] transition-colors duration-[var(--ag-duration-fast)] hover:bg-[var(--ag-color-brand-hover)]",
  secondary:
    "ag-focus-ring inline-flex min-h-11 items-center justify-center rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] px-5 text-[14px] font-medium text-[var(--ag-text-primary)] transition-colors duration-[var(--ag-duration-fast)] hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-hover)]",
} as const;

export function MarketingShell({ children, currentPath }: { children: ReactNode; currentPath: string }) {
  return (
    <main className="ag-page-shell min-h-screen overflow-hidden">
      <a className="ag-skip-link" href="#marketing-main">
        Skip to content
      </a>

      <header className="sticky top-0 z-30 border-b border-[var(--ag-border-subtle)] bg-[color:rgb(11_15_20_/_0.72)] backdrop-blur-xl">
        <div className="mx-auto flex w-full max-w-7xl items-center justify-between gap-4 px-5 py-4 sm:px-6 lg:px-8">
          <Link className="flex items-center gap-3" href={publicRoutes.landing}>
            <span className="flex h-10 w-10 items-center justify-center rounded-full border border-[color:rgb(10_205_207_/_0.28)] bg-[color:rgb(10_205_207_/_0.12)] font-mono text-sm font-semibold text-[var(--ag-color-brand)]">
              AG
            </span>
            <div className="space-y-0.5">
              <div className="ag-text-body-sm font-semibold">
                <span className="text-[var(--ag-text-primary)]">Agent</span>
                <span className="text-[var(--ag-color-brand)]">Git</span>
              </div>
              <div className="ag-text-overline text-[var(--ag-text-secondary)]">Cloud</div>
            </div>
          </Link>

          <nav className="hidden items-center gap-6 text-sm text-[var(--ag-text-secondary)] md:flex">
            <Link
              className={
                currentPath === publicRoutes.pricing
                  ? "text-[var(--ag-text-primary)]"
                  : "hover:text-[var(--ag-text-primary)]"
              }
              href={publicRoutes.pricing}
            >
              Pricing
            </Link>
            <Link
              className={
                currentPath === publicRoutes.docs
                  ? "text-[var(--ag-text-primary)]"
                  : "hover:text-[var(--ag-text-primary)]"
              }
              href={publicRoutes.docs}
            >
              Docs
            </Link>
            <Badge tone="brand">Hosted beta</Badge>
          </nav>

          <div className="flex items-center gap-3">
            <Link
              className="hidden text-sm text-[var(--ag-text-secondary)] transition-colors hover:text-[var(--ag-text-primary)] sm:inline-flex"
              href={publicRoutes.docs}
            >
              Quickstart
            </Link>
            <Link className={marketingLinkClasses.primary} href={publicRoutes.signIn}>
              Sign in with GitHub
            </Link>
          </div>
        </div>
      </header>

      <div id="marketing-main">{children}</div>

      <footer className="border-t border-[var(--ag-border-subtle)] bg-[color:rgb(7_11_16_/_0.92)]">
        <div className="mx-auto grid w-full max-w-7xl gap-8 px-5 py-10 text-sm text-[var(--ag-text-secondary)] sm:px-6 lg:grid-cols-[1.2fr_0.8fr] lg:px-8">
          <div className="space-y-3">
            <div className="text-base font-semibold text-[var(--ag-text-primary)]">
              The local daemon keeps authority close to the repo. The cloud keeps operators in sync.
            </div>
            <p className="max-w-2xl">
              AgentGit Cloud adds approvals, audit, calibration, fleet status, and operator visibility without moving
              execution out of the developer workspace.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Link className="hover:text-[var(--ag-text-primary)]" href={publicRoutes.landing}>
              Overview
            </Link>
            <Link className="hover:text-[var(--ag-text-primary)]" href={publicRoutes.pricing}>
              Pricing
            </Link>
            <Link className="hover:text-[var(--ag-text-primary)]" href={publicRoutes.docs}>
              Docs
            </Link>
          </div>
        </div>
      </footer>
    </main>
  );
}

export function MarketingSection({
  eyebrow,
  title,
  description,
  children,
  className,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("mx-auto w-full max-w-7xl px-5 py-16 sm:px-6 lg:px-8 lg:py-20", className)}>
      <div className="grid gap-10 lg:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)] lg:gap-16">
        <div className="space-y-4">
          <div className="ag-text-overline text-[var(--ag-color-brand)]">{eyebrow}</div>
          <h2 className="max-w-xl text-3xl font-semibold tracking-[-0.03em] text-[var(--ag-text-primary)] sm:text-4xl">
            {title}
          </h2>
          <p className="max-w-xl text-base leading-7 text-[var(--ag-text-secondary)]">{description}</p>
        </div>
        <div>{children}</div>
      </div>
    </section>
  );
}
