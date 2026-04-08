import { requireApiSession } from "@/lib/auth/api-session";
import { listWorkspaceActivity } from "@/lib/backend/workspace/activity-feed";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";

export async function GET(request: Request) {
  const requestId = createRequestId(request);
  const { unauthorized, workspaceSession } = await requireApiSession(request);

  if (unauthorized) {
    return unauthorized;
  }

  try {
    return jsonWithRequestId(await listWorkspaceActivity(workspaceSession.activeWorkspace.id), undefined, requestId);
  } catch (error) {
    logRouteError("activity_get", requestId, error, {
      workspaceId: workspaceSession.activeWorkspace.id,
    });
    return jsonWithRequestId({ message: "Could not load activity. Retry." }, { status: 500 }, requestId);
  }
}
