import { getWorkspaceAuditLog } from "@/lib/api/endpoints/audit";
import { useCursorPaginatedQuery } from "@/lib/query/hooks/use-cursor-paginated-query";
import { queryKeys } from "@/lib/query/keys";

export function useAuditQuery() {
  return useCursorPaginatedQuery({
    queryKey: queryKeys.audit,
    queryFn: ({ cursor }) => getWorkspaceAuditLog({ cursor }),
  });
}
