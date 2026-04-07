import { parsePreviewStateValue } from "@/lib/navigation/search-params";
import { OnboardingPage } from "@/features/onboarding/onboarding-page";

export default async function OnboardingRoute({
  searchParams,
}: {
  searchParams?: Promise<{ state?: string | string[] }>;
}) {
  const resolvedSearchParams = await searchParams;
  const previewState = parsePreviewStateValue(resolvedSearchParams?.state);

  return <OnboardingPage previewState={previewState} />;
}
