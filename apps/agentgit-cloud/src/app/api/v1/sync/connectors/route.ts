import { requireApiRole } from "@/lib/auth/api-session";
import { listWorkspaceConnectors } from "@/lib/backend/control-plane/connectors";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";
import { isPaginationQueryError, parseCursorPaginationQuery } from "@/lib/pagination/cursor";

export async function GET(request: Request) {
  const requestId = createRequestId(request);
  const access = await requireApiRole("admin", request);

  if (access.denied) {
    return access.denied;
  }

  try {
    const pagination = parseCursorPaginationQuery(request);
    return jsonWithRequestId(
      await listWorkspaceConnectors(access.workspaceSession.activeWorkspace.id, new Date().toISOString(), pagination),
      undefined,
      requestId,
    );
  } catch (error) {
    if (isPaginationQueryError(error)) {
      return jsonWithRequestId({ message: "Pagination parameters are invalid." }, { status: 400 }, requestId);
    }

    logRouteError("sync_connectors_get", requestId, error, {
      workspaceId: access.workspaceSession.activeWorkspace.id,
    });
    return jsonWithRequestId({ message: "Could not load workspace connectors. Retry." }, { status: 500 }, requestId);
  }
}
