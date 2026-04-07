import { useQuery } from "@tanstack/react-query";

import { getWorkspaceIntegrations } from "@/lib/api/endpoints/integrations";
import { queryKeys } from "@/lib/query/keys";

export function useWorkspaceIntegrationsQuery() {
  return useQuery({
    queryKey: queryKeys.integrations,
    queryFn: () => getWorkspaceIntegrations(),
  });
}
