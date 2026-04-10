import { requireApiRole } from "@/lib/auth/api-session";
import { listWorkspaceAuditLog } from "@/lib/backend/workspace/audit-log";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";
import { isPaginationQueryError, parseCursorPaginationQuery } from "@/lib/pagination/cursor";

export async function GET(request: Request) {
  const requestId = createRequestId(request);
  const { denied, workspaceSession } = await requireApiRole("admin", request);

  if (denied) {
    return denied;
  }

  try {
    const pagination = parseCursorPaginationQuery(request);
    return jsonWithRequestId(
      await listWorkspaceAuditLog(workspaceSession.activeWorkspace.id, pagination),
      undefined,
      requestId,
    );
  } catch (error) {
    if (isPaginationQueryError(error)) {
      return jsonWithRequestId({ message: "Pagination parameters are invalid." }, { status: 400 }, requestId);
    }

    logRouteError("audit_get", requestId, error, {
      workspaceId: workspaceSession.activeWorkspace.id,
    });
    return jsonWithRequestId({ message: "Could not load audit log. Retry." }, { status: 500 }, requestId);
  }
}
