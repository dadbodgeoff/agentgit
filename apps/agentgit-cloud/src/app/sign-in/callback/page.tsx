import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { Card } from "@/components/primitives";
import { normalizeCallbackUrl } from "@/lib/auth/redirect";
import { authenticatedRoutes } from "@/lib/navigation/routes";

export default async function SignInCallbackPage({
  searchParams,
}: {
  searchParams?: Promise<{ callbackUrl?: string | string[] }>;
}) {
  const session = await auth();
  const resolvedSearchParams = await searchParams;

  if (session) {
    redirect(
      normalizeCallbackUrl(
        typeof resolvedSearchParams?.callbackUrl === "string"
          ? resolvedSearchParams.callbackUrl
          : authenticatedRoutes.dashboard,
      ),
    );
  }

  return (
    <main className="ag-page-shell flex min-h-screen items-center justify-center px-6 py-16">
      <Card className="w-full max-w-md text-center">
        <h1 className="text-xl font-semibold">Completing sign-in</h1>
        <p className="mt-2 text-sm text-[var(--ag-text-secondary)]">
          Authentication is returning to the app. If this page does not advance, return to sign-in and retry the flow.
        </p>
      </Card>
    </main>
  );
}
