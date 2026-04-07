import { useQuery } from "@tanstack/react-query";

import { getWorkspaceSettings } from "@/lib/api/endpoints/settings";
import { queryKeys } from "@/lib/query/keys";

export function useWorkspaceSettingsQuery() {
  return useQuery({
    queryKey: queryKeys.workspaceSettings,
    queryFn: () => getWorkspaceSettings(),
  });
}
