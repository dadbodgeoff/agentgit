import Link from "next/link";

import { Button, Card } from "@/components/primitives";
import { publicRoutes } from "@/lib/navigation/routes";

export default function SignInPage() {
  return (
    <main className="ag-page-shell flex min-h-screen items-center justify-center px-6 py-16">
      <Card className="w-full max-w-md space-y-6">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-[-0.02em]">Sign in</h1>
          <p className="text-sm text-[var(--ag-text-secondary)]">
            GitHub OAuth will be the primary authentication path for AgentGit Cloud.
          </p>
        </div>
        <Button className="w-full">Continue with GitHub</Button>
        <p className="text-xs text-[var(--ag-text-tertiary)]">
          OAuth callback route reserved at{" "}
          <Link className="text-[var(--ag-color-brand)]" href={publicRoutes.signInCallback}>
            {publicRoutes.signInCallback}
          </Link>
          .
        </p>
      </Card>
    </main>
  );
}
