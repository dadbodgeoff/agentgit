import { requireApiSession } from "@/lib/auth/api-session";
import { listWorkspaceActivity } from "@/lib/backend/workspace/activity-feed";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";
import { isPaginationQueryError, parseCursorPaginationQuery } from "@/lib/pagination/cursor";

export async function GET(request: Request) {
  const requestId = createRequestId(request);
  const { unauthorized, workspaceSession } = await requireApiSession(request);

  if (unauthorized) {
    return unauthorized;
  }

  try {
    const pagination = parseCursorPaginationQuery(request);
    return jsonWithRequestId(
      await listWorkspaceActivity(workspaceSession.activeWorkspace.id, pagination),
      undefined,
      requestId,
    );
  } catch (error) {
    if (isPaginationQueryError(error)) {
      return jsonWithRequestId({ message: "Pagination parameters are invalid." }, { status: 400 }, requestId);
    }

    logRouteError("activity_get", requestId, error, {
      workspaceId: workspaceSession.activeWorkspace.id,
    });
    return jsonWithRequestId({ message: "Could not load activity. Retry." }, { status: 500 }, requestId);
  }
}
