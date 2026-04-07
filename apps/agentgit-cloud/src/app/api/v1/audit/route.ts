import { requireApiSession } from "@/lib/auth/api-session";
import { listWorkspaceAuditLog } from "@/lib/backend/workspace/audit-log";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";

export async function GET(request: Request) {
  const requestId = createRequestId(request);
  const { unauthorized, workspaceSession } = await requireApiSession();

  if (unauthorized) {
    return unauthorized;
  }

  try {
    return jsonWithRequestId(listWorkspaceAuditLog(workspaceSession.activeWorkspace.id), undefined, requestId);
  } catch (error) {
    logRouteError("audit_get", requestId, error, {
      workspaceId: workspaceSession.activeWorkspace.id,
    });
    return jsonWithRequestId({ message: "Could not load audit log. Retry." }, { status: 500 }, requestId);
  }
}
