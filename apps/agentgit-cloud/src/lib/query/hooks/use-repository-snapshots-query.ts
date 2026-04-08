import { getRepositorySnapshots } from "@/lib/api/endpoints/repositories";
import { useCursorPaginatedQuery } from "@/lib/query/hooks/use-cursor-paginated-query";
import { queryKeys } from "@/lib/query/keys";
import type { PreviewState } from "@/schemas/cloud";

export function useRepositorySnapshotsQuery(owner: string, name: string, previewState: PreviewState) {
  return useCursorPaginatedQuery({
    queryKey: [...queryKeys.repositorySnapshots(owner, name), previewState],
    queryFn: ({ cursor }) => getRepositorySnapshots(owner, name, { previewState, cursor }),
  });
}
