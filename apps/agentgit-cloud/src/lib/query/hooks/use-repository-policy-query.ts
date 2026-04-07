import { useQuery } from "@tanstack/react-query";

import { getRepositoryPolicy } from "@/lib/api/endpoints/repositories";
import { queryKeys } from "@/lib/query/keys";
import type { PreviewState } from "@/schemas/cloud";

export function useRepositoryPolicyQuery(owner: string, name: string, previewState: PreviewState) {
  return useQuery({
    queryKey: [...queryKeys.repositoryPolicy(owner, name), previewState],
    queryFn: () => getRepositoryPolicy(owner, name, previewState),
  });
}
