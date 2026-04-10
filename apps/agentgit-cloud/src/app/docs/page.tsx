import Link from "next/link";
import type { Metadata } from "next";

import { Badge } from "@/components/primitives";
import { MarketingSection, MarketingShell, marketingLinkClasses } from "@/features/marketing/marketing-shell";
import { buildPageMetadata } from "@/lib/metadata/site";
import { publicRoutes } from "@/lib/navigation/routes";

export const metadata: Metadata = buildPageMetadata({
  title: "Docs",
  description:
    "Read the AgentGit Cloud quickstart for onboarding a workspace, bootstrapping a connector, and proving the approval round trip end to end.",
  path: publicRoutes.docs,
});

export default function DocsPage() {
  return (
    <MarketingShell currentPath={publicRoutes.docs}>
      <section className="border-b border-[var(--ag-border-subtle)]">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-5 py-16 sm:px-6 lg:px-8 lg:py-20">
          <Badge tone="brand" className="w-fit">
            Operator quickstart
          </Badge>
          <div className="max-w-4xl space-y-5">
            <h1 className="text-5xl font-semibold tracking-[-0.04em] text-[var(--ag-text-primary)] sm:text-6xl">
              Bring the connector online, prove the approval round trip, then scale.
            </h1>
            <p className="max-w-3xl text-lg leading-8 text-[var(--ag-text-secondary)]">
              These docs are intentionally short. The fastest hosted rollout is one workspace, one connector, one
              governed action, and one operator decision path.
            </p>
          </div>
        </div>
      </section>

      <MarketingSection
        description="The quickest path to value is to treat the first launch like an operator drill, not a mass migration."
        eyebrow="Quickstart"
        title="Four steps to the first real approval loop."
      >
        <div className="grid gap-4">
          {[
            {
              title: "Create or sign into the hosted workspace",
              body: "Use GitHub sign-in, confirm the active workspace, and verify owner or admin access before touching the connector path.",
            },
            {
              title: "Connect the repository scope in the cloud",
              body: "Select the repositories this workspace is allowed to govern so the hosted inventory stays tenant-scoped and operator-safe.",
            },
            {
              title: "Bootstrap one connector from the local workspace",
              body: "Generate a bootstrap token, run the connector against the repo root, and watch heartbeats appear in the hosted fleet surface.",
            },
            {
              title: "Exercise one governed action end to end",
              body: "Trigger a safe action that requires approval, resolve it from the cloud UI, and confirm the daemon executes after the connector pulls the command.",
            },
          ].map((item, index) => (
            <div className="flex gap-4 border-t border-[var(--ag-border-subtle)] pt-4" key={item.title}>
              <div className="font-mono text-sm text-[var(--ag-color-brand)]">0{index + 1}</div>
              <div className="space-y-2">
                <div className="text-lg font-semibold text-[var(--ag-text-primary)]">{item.title}</div>
                <p className="max-w-3xl text-base leading-7 text-[var(--ag-text-secondary)]">{item.body}</p>
              </div>
            </div>
          ))}
        </div>
      </MarketingSection>

      <MarketingSection
        description="This is the minimal hosted setup path for a real workspace. Run it from the repo machine that already hosts the local daemon and AgentGit state."
        eyebrow="Bootstrap command"
        title="Connector bootstrap"
      >
        <div className="overflow-hidden rounded-[28px] border border-[var(--ag-border-subtle)] bg-[color:rgb(255_255_255_/_0.02)]">
          <div className="border-b border-[var(--ag-border-subtle)] px-5 py-3 font-mono text-xs uppercase tracking-[0.18em] text-[var(--ag-text-secondary)]">
            Local shell
          </div>
          <pre className="overflow-x-auto px-5 py-5 font-mono text-sm leading-7 text-[var(--ag-text-primary)]">
            {`agentgit-cloud-connector bootstrap \\
  --cloud-url https://cloud.example.com \\
  --workspace-id ws_acme_01 \\
  --workspace-root /Users/me/code/platform-ui \\
  --bootstrap-token agcbt_... && \\
agentgit-cloud-connector run \\
  --workspace-root /Users/me/code/platform-ui`}
          </pre>
        </div>
      </MarketingSection>

      <MarketingSection
        description="If these checks are green, the hosted loop is alive. If one fails, stop there instead of widening rollout."
        eyebrow="First-run validation"
        title="What to verify before you call the workspace live."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          {[
            "Connector heartbeats show as active in the cloud fleet view.",
            "Repository inventory and dashboard data match the intended workspace scope.",
            "An approval request appears in the hosted queue within a few seconds.",
            "Approving or rejecting from the cloud sends a command back to the connector.",
            "Activity and audit surfaces show the decision trail without manual reloads.",
            "Billing and plan limits reflect the expected seat and repository envelope.",
          ].map((item) => (
            <div
              className="border-t border-[var(--ag-border-subtle)] pt-4 text-base leading-7 text-[var(--ag-text-secondary)]"
              key={item}
            >
              {item}
            </div>
          ))}
        </div>
      </MarketingSection>

      <MarketingSection
        description="The hosted beta is honest about what is live today and what is still intentionally deferred."
        eyebrow="Operational notes"
        title="Current product boundaries"
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-[28px] border border-[var(--ag-border-subtle)] bg-[color:rgb(255_255_255_/_0.02)] p-6">
            <div className="font-mono text-xs uppercase tracking-[0.18em] text-[var(--ag-color-brand)]">Live now</div>
            <div className="mt-3 space-y-3 text-base leading-7 text-[var(--ag-text-secondary)]">
              <p>
                Durable workspaces, membership-backed auth, connector sync, approval round trips, hosted notifications,
                rate limiting, and beta-gated billing enforcement.
              </p>
            </div>
          </div>
          <div className="rounded-[28px] border border-[var(--ag-border-subtle)] bg-[color:rgb(255_255_255_/_0.02)] p-6">
            <div className="font-mono text-xs uppercase tracking-[0.18em] text-[var(--ag-color-warning)]">
              Still deferred
            </div>
            <div className="mt-3 space-y-3 text-base leading-7 text-[var(--ag-text-secondary)]">
              <p>
                Broader self-serve workspace invitation funnels and any environment-specific billing work beyond the
                current Stripe-or-beta-gate operator path.
              </p>
            </div>
          </div>
        </div>
      </MarketingSection>

      <section className="border-t border-[var(--ag-border-subtle)] bg-[color:rgb(7_11_16_/_0.94)]">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-5 py-16 sm:px-6 lg:flex-row lg:items-end lg:justify-between lg:px-8">
          <div className="space-y-4">
            <div className="font-mono text-xs uppercase tracking-[0.22em] text-[var(--ag-color-brand)]">
              Need the plan envelope too?
            </div>
            <h2 className="max-w-3xl text-3xl font-semibold tracking-[-0.03em] text-[var(--ag-text-primary)] sm:text-4xl">
              Compare hosted plan limits before you bring more repos or seats online.
            </h2>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link className={marketingLinkClasses.primary} href={publicRoutes.pricing}>
              View pricing
            </Link>
            <Link className={marketingLinkClasses.secondary} href={publicRoutes.signIn}>
              Open the app
            </Link>
          </div>
        </div>
      </section>
    </MarketingShell>
  );
}
