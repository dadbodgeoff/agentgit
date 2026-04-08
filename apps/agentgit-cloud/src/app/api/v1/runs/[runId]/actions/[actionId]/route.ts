import { requireApiSession } from "@/lib/auth/api-session";
import { getActionDetail } from "@/lib/backend/workspace/action-detail";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";

export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string; actionId: string }> },
) {
  const requestId = createRequestId(request);
  const { unauthorized, workspaceSession } = await requireApiSession(request);

  if (unauthorized) {
    return unauthorized;
  }

  const { runId, actionId } = await context.params;
  const url = new URL(request.url);
  const owner = url.searchParams.get("owner");
  const name = url.searchParams.get("name");
  if (!owner || !name) {
    return jsonWithRequestId(
      { message: "Repository owner and name are required for action detail." },
      { status: 400 },
      requestId,
    );
  }

  try {
    const detail = await getActionDetail(owner, name, runId, actionId, workspaceSession.activeWorkspace.id);
    if (!detail) {
      return jsonWithRequestId({ message: "Action detail was not found." }, { status: 404 }, requestId);
    }

    return jsonWithRequestId(detail, undefined, requestId);
  } catch (error) {
    logRouteError("run_action_detail_get", requestId, error, {
      workspaceId: workspaceSession.activeWorkspace.id,
      owner,
      name,
      runId,
      actionId,
    });
    return jsonWithRequestId({ message: "Could not load action detail. Retry." }, { status: 500 }, requestId);
  }
}
