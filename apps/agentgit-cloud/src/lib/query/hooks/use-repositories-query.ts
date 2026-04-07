import { useQuery } from "@tanstack/react-query";

import { getRepositories } from "@/lib/api/endpoints/repositories";
import { queryKeys } from "@/lib/query/keys";
import type { PreviewState } from "@/schemas/cloud";

export function useRepositoriesQuery(previewState: PreviewState) {
  return useQuery({
    queryKey: [...queryKeys.repositories, previewState],
    queryFn: () => getRepositories(previewState),
  });
}
