import { useQuery } from "@tanstack/react-query";

import { getWorkspaceBilling } from "@/lib/api/endpoints/billing";
import { queryKeys } from "@/lib/query/keys";

export function useWorkspaceBillingQuery() {
  return useQuery({
    queryKey: queryKeys.billing,
    queryFn: () => getWorkspaceBilling(),
  });
}
