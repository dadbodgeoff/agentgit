import { requireApiRole } from "@/lib/auth/api-session";
import { createRequestId, jsonWithRequestId } from "@/lib/observability/route-response";
import { resolveWorkspaceStripeBillingStatus } from "@/lib/backend/workspace/workspace-billing";

export async function GET(request: Request) {
  const requestId = createRequestId(request);
  const access = await requireApiRole("owner", request);

  if (access.denied) {
    return access.denied;
  }

  return jsonWithRequestId(await resolveWorkspaceStripeBillingStatus(access.workspaceSession), undefined, requestId);
}
