import { useQuery } from "@tanstack/react-query";

import { getDashboardSummary } from "@/lib/api/endpoints/dashboard";
import { queryKeys } from "@/lib/query/keys";
import type { PreviewState } from "@/schemas/cloud";

export function useDashboardQuery(previewState: PreviewState) {
  return useQuery({
    queryKey: [...queryKeys.dashboard, previewState],
    queryFn: () => getDashboardSummary(previewState),
  });
}
