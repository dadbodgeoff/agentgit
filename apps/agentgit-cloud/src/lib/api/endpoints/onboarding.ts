import { fetchJson } from "@/lib/api/client";
import {
  OnboardingBootstrapSchema,
  OnboardingFormValuesSchema,
  OnboardingLaunchResponseSchema,
  type OnboardingBootstrap,
  type OnboardingFormValues,
  type OnboardingLaunchResponse,
  type PreviewState,
} from "@/schemas/cloud";

export async function getOnboardingBootstrap(previewState: PreviewState = "ready"): Promise<OnboardingBootstrap> {
  const url = new URL("/api/v1/onboarding", "http://localhost");

  if (previewState !== "ready") {
    url.searchParams.set("state", previewState);
  }

  const response = await fetchJson<unknown>(url.pathname + url.search);
  return OnboardingBootstrapSchema.parse(response);
}

export async function launchOnboarding(values: OnboardingFormValues): Promise<OnboardingLaunchResponse> {
  const response = await fetchJson<unknown>("/api/v1/onboarding", {
    method: "POST",
    body: JSON.stringify(OnboardingFormValuesSchema.parse(values)),
  });

  return OnboardingLaunchResponseSchema.parse(response);
}
