import { getApprovalQueue } from "@/lib/api/endpoints/approvals";
import { useCursorPaginatedQuery } from "@/lib/query/hooks/use-cursor-paginated-query";
import { queryKeys } from "@/lib/query/keys";
import type { PreviewState } from "@/schemas/cloud";

export function useApprovalsQuery(previewState: PreviewState) {
  return useCursorPaginatedQuery({
    queryKey: [...queryKeys.approvals, previewState],
    queryFn: ({ cursor }) => getApprovalQueue({ previewState, cursor }),
  });
}
