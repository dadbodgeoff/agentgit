import { useQuery } from "@tanstack/react-query";

import { getWorkspaceAuditLog } from "@/lib/api/endpoints/audit";
import { queryKeys } from "@/lib/query/keys";

export function useAuditQuery() {
  return useQuery({
    queryKey: queryKeys.audit,
    queryFn: () => getWorkspaceAuditLog(),
  });
}
