import { useQuery } from "@tanstack/react-query";

import { getWorkspaceConnectors } from "@/lib/api/endpoints/connectors";
import { queryKeys } from "@/lib/query/keys";

export function useWorkspaceConnectorsQuery() {
  return useQuery({
    queryKey: queryKeys.connectors,
    queryFn: () => getWorkspaceConnectors(),
  });
}
