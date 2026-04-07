import { useQuery } from "@tanstack/react-query";

import { getRepositoryDetail } from "@/lib/api/endpoints/repositories";
import { queryKeys } from "@/lib/query/keys";
import type { PreviewState } from "@/schemas/cloud";

export function useRepositoryDetailQuery(owner: string, name: string, previewState: PreviewState) {
  return useQuery({
    queryKey: [...queryKeys.repository(owner, name), previewState],
    queryFn: () => getRepositoryDetail(owner, name, previewState),
  });
}
