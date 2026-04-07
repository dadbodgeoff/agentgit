import { useQuery } from "@tanstack/react-query";

import { getApprovalQueue } from "@/lib/api/endpoints/approvals";
import { queryKeys } from "@/lib/query/keys";
import type { PreviewState } from "@/schemas/cloud";

export function useApprovalsQuery(previewState: PreviewState) {
  return useQuery({
    queryKey: [...queryKeys.approvals, previewState],
    queryFn: () => getApprovalQueue(previewState),
  });
}
