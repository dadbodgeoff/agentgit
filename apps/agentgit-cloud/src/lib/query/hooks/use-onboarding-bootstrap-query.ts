import { useQuery } from "@tanstack/react-query";

import { getOnboardingBootstrap } from "@/lib/api/endpoints/onboarding";
import { queryKeys } from "@/lib/query/keys";
import type { PreviewState } from "@/schemas/cloud";

export function useOnboardingBootstrapQuery(previewState: PreviewState) {
  return useQuery({
    queryKey: [...queryKeys.onboarding, previewState],
    queryFn: () => getOnboardingBootstrap(previewState),
  });
}
