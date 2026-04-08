import { useQuery } from "@tanstack/react-query";

import { getRepositoryConnectionBootstrap } from "@/lib/api/endpoints/repositories";
import { queryKeys } from "@/lib/query/keys";

export function useRepositoryConnectionBootstrapQuery(enabled = true) {
  return useQuery({
    queryKey: queryKeys.repositoryConnection,
    queryFn: () => getRepositoryConnectionBootstrap(),
    enabled,
  });
}
