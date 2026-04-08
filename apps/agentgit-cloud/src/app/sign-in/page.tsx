import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { SignInCard } from "@/features/auth/sign-in-card";
import { authFeatureFlags } from "@/lib/auth/provider-config";
import { normalizeCallbackUrl } from "@/lib/auth/redirect";
import { authenticatedRoutes } from "@/lib/navigation/routes";

export const dynamic = "force-dynamic";

export default async function SignInPage({
  searchParams,
}: {
  searchParams?: Promise<{ callbackUrl?: string | string[]; error?: string | string[] }>;
}) {
  const session = await auth();
  const resolvedSearchParams = await searchParams;

  if (session) {
    redirect(authenticatedRoutes.dashboard);
  }

  const callbackUrl = normalizeCallbackUrl(
    typeof resolvedSearchParams?.callbackUrl === "string" ? resolvedSearchParams.callbackUrl : undefined,
  );
  const error =
    typeof resolvedSearchParams?.error === "string" ? resolvedSearchParams.error : undefined;

  return (
    <main className="ag-page-shell flex min-h-screen items-center justify-center px-6 py-16">
      <SignInCard
        callbackUrl={callbackUrl}
        enableDevelopmentCredentials={authFeatureFlags.enableDevelopmentCredentials}
        enableGitHub={authFeatureFlags.hasGitHubProvider}
        errorMessage={error}
      />
    </main>
  );
}
