import { getRepositoryRuns } from "@/lib/api/endpoints/repositories";
import { useCursorPaginatedQuery } from "@/lib/query/hooks/use-cursor-paginated-query";
import { queryKeys } from "@/lib/query/keys";
import type { PreviewState } from "@/schemas/cloud";

export function useRepositoryRunsQuery(owner: string, name: string, previewState: PreviewState) {
  return useCursorPaginatedQuery({
    queryKey: [...queryKeys.runs(owner, name), previewState],
    queryFn: ({ cursor }) => getRepositoryRuns(owner, name, { previewState, cursor }),
  });
}
