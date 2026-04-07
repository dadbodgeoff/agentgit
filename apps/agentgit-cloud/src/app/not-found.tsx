import Link from "next/link";

import { Button, Card } from "@/components/primitives";

export default function NotFound() {
  return (
    <main className="ag-page-shell flex min-h-screen items-center justify-center px-6 py-16">
      <Card className="w-full max-w-lg space-y-4 text-center">
        <h1 className="text-3xl font-semibold tracking-[-0.02em]">Page not found</h1>
        <p className="text-sm text-[var(--ag-text-secondary)]">
          The route does not exist yet, or it has not been wired into the cloud product flow.
        </p>
        <div className="flex justify-center">
          <Link href="/app">
            <Button>Go to dashboard</Button>
          </Link>
        </div>
      </Card>
    </main>
  );
}
