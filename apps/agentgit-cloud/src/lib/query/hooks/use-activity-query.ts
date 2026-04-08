import { getWorkspaceActivity } from "@/lib/api/endpoints/activity";
import { useCursorPaginatedQuery } from "@/lib/query/hooks/use-cursor-paginated-query";
import { queryKeys } from "@/lib/query/keys";

export function useActivityQuery() {
  return useCursorPaginatedQuery({
    queryKey: queryKeys.activity,
    queryFn: ({ cursor }) => getWorkspaceActivity({ cursor }),
  });
}
