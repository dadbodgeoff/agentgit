import { useQuery } from "@tanstack/react-query";

import { getRepositorySnapshots } from "@/lib/api/endpoints/repositories";
import { queryKeys } from "@/lib/query/keys";
import type { PreviewState } from "@/schemas/cloud";

export function useRepositorySnapshotsQuery(owner: string, name: string, previewState: PreviewState) {
  return useQuery({
    queryKey: [...queryKeys.repositorySnapshots(owner, name), previewState],
    queryFn: () => getRepositorySnapshots(owner, name, previewState),
  });
}
