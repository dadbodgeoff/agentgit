import { useQuery } from "@tanstack/react-query";

import { getRunDetail } from "@/lib/api/endpoints/runs";
import { queryKeys } from "@/lib/query/keys";
import type { PreviewState } from "@/schemas/cloud";

export function useRunDetailQuery(runId: string, previewState: PreviewState) {
  return useQuery({
    queryKey: [...queryKeys.run(runId), previewState],
    queryFn: () => getRunDetail(runId, previewState),
  });
}
