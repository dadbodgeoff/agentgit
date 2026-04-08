import Link from "next/link";
import type { Metadata } from "next";

import { Badge } from "@/components/primitives";
import { MarketingSection, MarketingShell, marketingLinkClasses } from "@/features/marketing/marketing-shell";
import { buildPageMetadata } from "@/lib/metadata/site";
import { publicRoutes } from "@/lib/navigation/routes";

export const metadata: Metadata = buildPageMetadata({
  title: "AgentGit Cloud",
  description:
    "AgentGit Cloud is the hosted control plane for governed agent approvals, connector fleet visibility, audit trails, and recovery context.",
  path: publicRoutes.landing,
});

export default function LandingPage() {
  return (
    <MarketingShell currentPath={publicRoutes.landing}>
      <section className="relative border-b border-[var(--ag-border-subtle)]">
        <div className="ag-signal-panel ag-signal-grid ag-scanline">
          <div className="mx-auto grid min-h-[calc(100svh-73px)] w-full max-w-7xl gap-12 px-5 py-14 sm:px-6 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)] lg:px-8 lg:py-20">
            <div className="ag-reveal flex flex-col justify-center gap-8">
              <div className="space-y-5">
                <div className="flex flex-wrap items-center gap-3">
                  <Badge tone="accent">Hosted beta</Badge>
                  <span className="font-mono text-xs uppercase tracking-[0.22em] text-[var(--ag-text-secondary)]">
                    Local execution. Cloud oversight.
                  </span>
                </div>
                <h1 className="max-w-4xl text-5xl font-semibold tracking-[-0.04em] text-[var(--ag-text-primary)] sm:text-6xl lg:text-7xl">
                  Govern every agent action before it turns into repo history.
                </h1>
                <p className="max-w-2xl text-lg leading-8 text-[var(--ag-text-secondary)]">
                  AgentGit Cloud gives operators a live approval rail, durable audit, fleet status, and recovery context
                  while the actual work still runs inside the local daemon next to the code.
                </p>
              </div>

              <div className="flex flex-wrap gap-3">
                <Link className={marketingLinkClasses.primary} href={publicRoutes.signIn}>
                  Start hosted beta
                </Link>
                <Link className={marketingLinkClasses.secondary} href={publicRoutes.docs}>
                  Read the quickstart
                </Link>
              </div>

              <div className="grid gap-4 border-t border-[var(--ag-border-subtle)] pt-6 text-sm text-[var(--ag-text-secondary)] sm:grid-cols-3">
                <div>
                  <div className="font-mono text-xs uppercase tracking-[0.18em] text-[var(--ag-color-brand)]">
                    Approvals
                  </div>
                  <div className="mt-2 text-[var(--ag-text-primary)]">
                    Cloud inbox mirrors the local daemon in seconds.
                  </div>
                </div>
                <div>
                  <div className="font-mono text-xs uppercase tracking-[0.18em] text-[var(--ag-color-brand)]">
                    Recovery
                  </div>
                  <div className="mt-2 text-[var(--ag-text-primary)]">
                    Snapshots, audit, and replay stay visible per repo.
                  </div>
                </div>
                <div>
                  <div className="font-mono text-xs uppercase tracking-[0.18em] text-[var(--ag-color-brand)]">
                    Fleet
                  </div>
                  <div className="mt-2 text-[var(--ag-text-primary)]">
                    Track connectors, drift, and stale machines from one surface.
                  </div>
                </div>
              </div>
            </div>

            <div className="ag-reveal flex items-center" style={{ animationDelay: "140ms" }}>
              <div className="relative w-full overflow-hidden rounded-[32px] border border-[color:rgb(255_255_255_/_0.08)] bg-[color:rgb(13_18_24_/_0.9)] p-5 shadow-[0_30px_120px_rgb(0_0_0_/_0.35)]">
                <div className="grid gap-4 border-b border-[var(--ag-border-subtle)] pb-4 sm:grid-cols-[0.88fr_1.12fr]">
                  <div className="space-y-3 rounded-[24px] border border-[var(--ag-border-subtle)] bg-[color:rgb(255_255_255_/_0.02)] p-4">
                    <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--ag-text-secondary)]">
                      Local daemon
                    </div>
                    <div className="text-xl font-semibold text-[var(--ag-text-primary)]">
                      `deploy production release`
                    </div>
                    <div className="space-y-2 text-sm text-[var(--ag-text-secondary)]">
                      <div className="flex items-center justify-between">
                        <span>risk profile</span>
                        <span className="font-mono text-[var(--ag-color-warning)]">mutating</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>snapshot</span>
                        <span className="font-mono text-[var(--ag-text-primary)]">required</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>policy</span>
                        <span className="font-mono text-[var(--ag-color-brand)]">approval requested</span>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-3 rounded-[24px] border border-[color:rgb(10_205_207_/_0.16)] bg-[color:rgb(10_205_207_/_0.05)] p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--ag-color-brand)]">
                        Cloud control plane
                      </div>
                      <Badge tone="warning">Approval pending</Badge>
                    </div>
                    <div className="space-y-4">
                      <div className="text-sm leading-7 text-[var(--ag-text-secondary)]">
                        Connector `geoffrey-mbp` synced an approval request for `acme/platform-ui`.
                      </div>
                      <div className="grid gap-3 text-sm sm:grid-cols-2">
                        <div className="rounded-[18px] border border-[var(--ag-border-subtle)] bg-[color:rgb(255_255_255_/_0.02)] p-3">
                          <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--ag-text-secondary)]">
                            Operator choice
                          </div>
                          <div className="mt-2 text-[var(--ag-text-primary)]">
                            Approve, deny, or replay after review.
                          </div>
                        </div>
                        <div className="rounded-[18px] border border-[var(--ag-border-subtle)] bg-[color:rgb(255_255_255_/_0.02)] p-3">
                          <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--ag-text-secondary)]">
                            Round trip
                          </div>
                          <div className="mt-2 text-[var(--ag-text-primary)]">
                            Resolution is sent back over the connector command queue.
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="grid gap-3 pt-4 text-sm text-[var(--ag-text-secondary)] sm:grid-cols-3">
                  <div className="rounded-[18px] border border-[var(--ag-border-subtle)] p-3">
                    <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--ag-text-secondary)]">
                      Fleet health
                    </div>
                    <div className="mt-2 text-[var(--ag-text-primary)]">6 active connectors, 0 stale, 0 revoked</div>
                  </div>
                  <div className="rounded-[18px] border border-[var(--ag-border-subtle)] p-3">
                    <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--ag-text-secondary)]">
                      Audit coverage
                    </div>
                    <div className="mt-2 text-[var(--ag-text-primary)]">
                      Every action, approval, snapshot, and retry is queryable.
                    </div>
                  </div>
                  <div className="rounded-[18px] border border-[var(--ag-border-subtle)] p-3">
                    <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--ag-text-secondary)]">
                      Recovery posture
                    </div>
                    <div className="mt-2 text-[var(--ag-text-primary)]">
                      Snapshots stay attached to the repo where risk happened.
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <MarketingSection
        description="The hosted product is opinionated about where responsibility lives. Execution stays local, but the decision trail becomes visible and operationally useful."
        eyebrow="Product boundary"
        title="The cloud is not another runner. It is the operator surface for the runner you already trust."
      >
        <div className="grid gap-6 sm:grid-cols-3">
          {[
            {
              title: "Observe",
              body: "See approvals, failed runs, connector health, and workspace drift without shell access to every machine.",
            },
            {
              title: "Decide",
              body: "Approve or reject governed actions from the cloud and push that resolution back through the connector queue.",
            },
            {
              title: "Recover",
              body: "Keep snapshots, audit trails, and replay context tied to the exact repo where the action originated.",
            },
          ].map((item) => (
            <div className="border-t border-[var(--ag-border-subtle)] pt-5" key={item.title}>
              <div className="font-mono text-xs uppercase tracking-[0.18em] text-[var(--ag-color-brand)]">
                {item.title}
              </div>
              <p className="mt-3 text-base leading-7 text-[var(--ag-text-secondary)]">{item.body}</p>
            </div>
          ))}
        </div>
      </MarketingSection>

      <MarketingSection
        description="Hosted beta is already centered on the operator loop that matters most: risky action, approval request, cloud decision, local execution, durable audit."
        eyebrow="Primary workflow"
        title="The round trip is the product."
      >
        <div className="grid gap-4">
          {[
            "The local daemon raises a governed action that needs human approval.",
            "The connector syncs the approval request, repo context, and runtime status into the cloud control plane.",
            "An operator approves or rejects from the hosted queue, with audit and notification fan-out attached.",
            "The connector pulls the resolution command and the local daemon executes against the repo in place.",
          ].map((step, index) => (
            <div className="flex gap-4 border-t border-[var(--ag-border-subtle)] pt-4" key={step}>
              <div className="font-mono text-sm text-[var(--ag-color-brand)]">0{index + 1}</div>
              <p className="max-w-3xl text-base leading-7 text-[var(--ag-text-secondary)]">{step}</p>
            </div>
          ))}
        </div>
      </MarketingSection>

      <section className="border-t border-[var(--ag-border-subtle)] bg-[color:rgb(7_11_16_/_0.94)]">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-5 py-16 sm:px-6 lg:flex-row lg:items-end lg:justify-between lg:px-8">
          <div className="space-y-4">
            <div className="font-mono text-xs uppercase tracking-[0.22em] text-[var(--ag-color-brand)]">
              Launch with control
            </div>
            <h2 className="max-w-3xl text-3xl font-semibold tracking-[-0.03em] text-[var(--ag-text-primary)] sm:text-4xl">
              Bring one repo, one connector, and one approval path online first. Then widen the blast radius.
            </h2>
            <p className="max-w-2xl text-base leading-7 text-[var(--ag-text-secondary)]">
              The fastest way to adopt AgentGit Cloud is to connect a real workspace, prove the approval loop, and then
              let operators see what the daemon is already doing.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link className={marketingLinkClasses.primary} href={publicRoutes.docs}>
              Open quickstart
            </Link>
            <Link className={marketingLinkClasses.secondary} href={publicRoutes.pricing}>
              Compare plans
            </Link>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
