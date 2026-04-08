import { getRepositories } from "@/lib/api/endpoints/repositories";
import { useCursorPaginatedQuery } from "@/lib/query/hooks/use-cursor-paginated-query";
import { queryKeys } from "@/lib/query/keys";
import type { PreviewState } from "@/schemas/cloud";

export function useRepositoriesQuery(previewState: PreviewState) {
  return useCursorPaginatedQuery({
    queryKey: [...queryKeys.repositories, previewState],
    queryFn: ({ cursor }) => getRepositories({ previewState, cursor }),
  });
}
