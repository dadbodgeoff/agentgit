import { useQuery } from "@tanstack/react-query";

import { getWorkspaceActivity } from "@/lib/api/endpoints/activity";
import { queryKeys } from "@/lib/query/keys";

export function useActivityQuery() {
  return useQuery({
    queryKey: queryKeys.activity,
    queryFn: () => getWorkspaceActivity(),
  });
}
