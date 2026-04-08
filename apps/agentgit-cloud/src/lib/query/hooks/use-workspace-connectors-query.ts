import { getWorkspaceConnectors } from "@/lib/api/endpoints/connectors";
import { useCursorPaginatedQuery } from "@/lib/query/hooks/use-cursor-paginated-query";
import { queryKeys } from "@/lib/query/keys";

export function useWorkspaceConnectorsQuery() {
  return useCursorPaginatedQuery({
    queryKey: queryKeys.connectors,
    queryFn: ({ cursor }) => getWorkspaceConnectors({ cursor }),
  });
}
