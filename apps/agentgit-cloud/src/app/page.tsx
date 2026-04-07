import Link from "next/link";

import { Button, Card } from "@/components/primitives";
import { publicRoutes } from "@/lib/navigation/routes";

export default function LandingPage() {
  return (
    <main className="ag-page-shell flex min-h-screen items-center justify-center px-6 py-16">
      <div className="mx-auto grid w-full max-w-6xl gap-8 lg:grid-cols-[1.3fr_0.7fr]">
        <section className="space-y-6">
          <span className="inline-flex rounded-full border border-[var(--ag-border-default)] px-3 py-1 text-xs text-[var(--ag-text-secondary)]">
            Hosted governance for autonomous engineering
          </span>
          <div className="space-y-4">
            <h1 className="max-w-3xl text-5xl font-semibold tracking-[-0.03em]">
              Review what the agent is doing before the codebase becomes the story.
            </h1>
            <p className="max-w-2xl text-base text-[var(--ag-text-secondary)]">
              AgentGit Cloud adds approvals, calibration, audit, and multi-repository oversight on top of the
              local-first authority runtime.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link href={publicRoutes.signIn}>
              <Button>Sign in with GitHub</Button>
            </Link>
            <Link href={publicRoutes.pricing}>
              <Button variant="secondary">View pricing</Button>
            </Link>
          </div>
        </section>
        <Card className="ag-dot-grid space-y-4">
          <h2 className="text-lg font-semibold">Scaffold status</h2>
          <ul className="space-y-2 text-sm text-[var(--ag-text-secondary)]">
            <li>Cloud route map wired into the app router</li>
            <li>Token-backed theme layer added</li>
            <li>App shell and primitives scaffolded</li>
            <li>Feature folders reserved for priority journeys</li>
          </ul>
        </Card>
      </div>
    </main>
  );
}
