import { useQuery } from "@tanstack/react-query";

import { getActionDetail } from "@/lib/api/endpoints/runs";
import { queryKeys } from "@/lib/query/keys";

export function useActionDetailQuery(owner: string, name: string, runId: string, actionId: string) {
  return useQuery({
    queryKey: queryKeys.action(runId, actionId),
    queryFn: () => getActionDetail(owner, name, runId, actionId),
  });
}
