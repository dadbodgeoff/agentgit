import { useQuery } from "@tanstack/react-query";

import { getRepositoryRuns } from "@/lib/api/endpoints/repositories";
import { queryKeys } from "@/lib/query/keys";
import type { PreviewState } from "@/schemas/cloud";

export function useRepositoryRunsQuery(owner: string, name: string, previewState: PreviewState) {
  return useQuery({
    queryKey: [...queryKeys.runs(owner, name), previewState],
    queryFn: () => getRepositoryRuns(owner, name, previewState),
  });
}
