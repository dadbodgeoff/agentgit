import { useQuery } from "@tanstack/react-query";

import { getWorkspaceTeam } from "@/lib/api/endpoints/team";
import { queryKeys } from "@/lib/query/keys";

export function useWorkspaceTeamQuery() {
  return useQuery({
    queryKey: queryKeys.workspaceTeam,
    queryFn: () => getWorkspaceTeam(),
  });
}
