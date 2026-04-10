import Link from "next/link";
import type { Metadata } from "next";

import { Badge } from "@/components/primitives";
import { MarketingSection, MarketingShell, marketingLinkClasses } from "@/features/marketing/marketing-shell";
import { buildPageMetadata } from "@/lib/metadata/site";
import { publicRoutes } from "@/lib/navigation/routes";

export const metadata: Metadata = buildPageMetadata({
  title: "Pricing",
  description:
    "Compare AgentGit Cloud hosted beta pricing for starter, team, and enterprise control-plane coverage across seats, repositories, and approvals.",
  path: publicRoutes.pricing,
});

export default function PricingPage() {
  return (
    <MarketingShell currentPath={publicRoutes.pricing}>
      <section className="border-b border-[var(--ag-border-subtle)]">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-5 py-16 sm:px-6 lg:px-8 lg:py-20">
          <Badge tone="brand" className="w-fit">
            Hosted beta pricing
          </Badge>
          <div className="max-w-4xl space-y-5">
            <h1 className="text-5xl font-semibold tracking-[-0.04em] text-[var(--ag-text-primary)] sm:text-6xl">
              Price the control plane by the amount of governed software you need to operate.
            </h1>
            <p className="max-w-3xl text-lg leading-8 text-[var(--ag-text-secondary)]">
              The daemon stays local and open. The hosted plan pays for approvals, fleet visibility, audit retention,
              operator workflows, and multi-repository oversight.
            </p>
          </div>
        </div>
      </section>

      <MarketingSection
        description="AgentGit Cloud can run in two truthful billing modes: the hosted beta gate for unconfigured environments, or live Stripe checkout and portal flows when Stripe is enabled."
        eyebrow="Plan envelope"
        title="Three operating bands for teams shipping agent-driven code."
      >
        <div className="grid gap-5 xl:grid-cols-3">
          {[
            {
              name: "Starter",
              price: "$199",
              cadence: "per month",
              limits: ["Up to 5 seats", "Up to 10 repositories", "Up to 1,000 approvals / 30d"],
              note: "Best for one team proving the operator loop in production-like conditions.",
              accent: false,
            },
            {
              name: "Team",
              price: "$1,490",
              cadence: "per month",
              limits: ["Up to 15 seats", "Up to 40 repositories", "Up to 5,000 approvals / 30d"],
              note: "Best for engineering orgs that need shared approval, audit, and fleet surfaces.",
              accent: true,
            },
            {
              name: "Enterprise",
              price: "$4,990",
              cadence: "per month",
              limits: ["Up to 50 seats", "Up to 150 repositories", "Up to 20,000 approvals / 30d"],
              note: "Best for procurement review, wider fleet coverage, and larger governed change volume.",
              accent: false,
            },
          ].map((plan) => (
            <div
              className={
                plan.accent
                  ? "ag-signal-panel overflow-hidden rounded-[28px] border border-[color:rgb(10_205_207_/_0.24)] bg-[color:rgb(10_205_207_/_0.06)] p-6"
                  : "overflow-hidden rounded-[28px] border border-[var(--ag-border-subtle)] bg-[color:rgb(255_255_255_/_0.02)] p-6"
              }
              key={plan.name}
            >
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-2xl font-semibold text-[var(--ag-text-primary)]">{plan.name}</h2>
                  {plan.accent ? <Badge tone="brand">Recommended</Badge> : null}
                </div>
                <div className="flex items-end gap-2">
                  <div className="text-4xl font-semibold tracking-[-0.04em] text-[var(--ag-text-primary)]">
                    {plan.price}
                  </div>
                  <div className="pb-1 text-sm text-[var(--ag-text-secondary)]">{plan.cadence}</div>
                </div>
                <p className="text-base leading-7 text-[var(--ag-text-secondary)]">{plan.note}</p>
                <div className="space-y-3 border-t border-[var(--ag-border-subtle)] pt-4 text-sm text-[var(--ag-text-secondary)]">
                  {plan.limits.map((limit) => (
                    <div key={limit}>{limit}</div>
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      </MarketingSection>

      <MarketingSection
        description="The hosted product is deliberately scoped so teams can keep execution local while still buying shared operational control."
        eyebrow="What is included"
        title="Cloud capabilities that do not belong in the local daemon."
      >
        <div className="overflow-hidden rounded-[28px] border border-[var(--ag-border-subtle)]">
          <div className="grid grid-cols-[1.25fr_repeat(3,minmax(0,0.58fr))] border-b border-[var(--ag-border-subtle)] bg-[color:rgb(255_255_255_/_0.02)] px-4 py-3 text-sm font-semibold text-[var(--ag-text-primary)]">
            <div>Capability</div>
            <div>Starter</div>
            <div>Team</div>
            <div>Enterprise</div>
          </div>
          {[
            ["Hosted approval inbox and command relay", "Yes", "Yes", "Yes"],
            ["Connector fleet visibility", "Basic", "Full", "Full"],
            ["Audit and activity surfaces", "30 days", "90 days", "Custom"],
            ["Notification routing", "Email", "Email + Slack", "Email + Slack"],
            ["Operator onboarding support", "Self-serve", "Guided", "Guided"],
          ].map((row) => (
            <div
              className="grid grid-cols-[1.25fr_repeat(3,minmax(0,0.58fr))] border-b border-[var(--ag-border-subtle)] px-4 py-4 text-sm text-[var(--ag-text-secondary)] last:border-b-0"
              key={row[0]}
            >
              {row.map((cell, index) => (
                <div className={index === 0 ? "text-[var(--ag-text-primary)]" : ""} key={`${row[0]}-${cell}`}>
                  {cell}
                </div>
              ))}
            </div>
          ))}
        </div>
      </MarketingSection>

      <MarketingSection
        description="The billing surface stays honest in both modes: beta gate when Stripe is not configured, live processor state when it is."
        eyebrow="Billing reality"
        title="Beta gate fallback, live Stripe when enabled."
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-[28px] border border-[var(--ag-border-subtle)] bg-[color:rgb(255_255_255_/_0.02)] p-6">
            <div className="font-mono text-xs uppercase tracking-[0.06em] text-[var(--ag-color-brand)]">
              During beta
            </div>
            <div className="mt-3 space-y-3 text-base leading-7 text-[var(--ag-text-secondary)]">
              <p>
                Owners set the intended plan, the cloud enforces seat and repository caps, and approval volume overages
                stay visible in billing.
              </p>
              <p>No fake invoices. No pretend card portal. No surprise billing behavior that operators cannot trust.</p>
            </div>
          </div>
          {/*
            Brand Identity v2 §5.1 / §14: Signal Lime is reserved for
            agent-initiated actions only. "When Stripe is enabled" describes
            the connected/live billing state, which maps to spec §7.2
            success semantics ("connected"). Use --ag-color-success here.
          */}
          <div className="rounded-[28px] border border-[color:rgb(16_185_129_/_0.22)] bg-[color:rgb(16_185_129_/_0.06)] p-6">
            <div className="font-mono text-xs uppercase tracking-[0.06em] text-[var(--ag-color-success)]">
              When Stripe is enabled
            </div>
            <div className="mt-3 space-y-3 text-base leading-7 text-[var(--ag-text-secondary)]">
              <p>
                Checkout, renewal, customer portal, and invoice history flow through the same owner-facing billing
                surface that the hosted beta gate already uses.
              </p>
              <p>
                The entitlement model stays the same, so the beta gate remains a truthful fallback instead of throwaway
                UI.
              </p>
            </div>
          </div>
        </div>
      </MarketingSection>

      <section className="border-t border-[var(--ag-border-subtle)] bg-[color:rgb(7_11_16_/_0.94)]">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-5 py-16 sm:px-6 lg:flex-row lg:items-end lg:justify-between lg:px-8">
          <div className="space-y-4">
            <div className="font-mono text-xs uppercase tracking-[0.22em] text-[var(--ag-color-brand)]">
              Ready to evaluate
            </div>
            <h2 className="max-w-3xl text-3xl font-semibold tracking-[-0.03em] text-[var(--ag-text-primary)] sm:text-4xl">
              Start with one repo and prove the approval loop before you widen coverage.
            </h2>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link className={marketingLinkClasses.primary} href={publicRoutes.signIn}>
              Join hosted beta
            </Link>
            <Link className={marketingLinkClasses.secondary} href={publicRoutes.docs}>
              Review quickstart
            </Link>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
