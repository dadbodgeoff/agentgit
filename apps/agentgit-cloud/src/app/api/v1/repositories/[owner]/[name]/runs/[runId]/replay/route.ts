import { requireApiRole } from "@/lib/auth/api-session";
import { hasRepositoryRouteAccess } from "@/lib/backend/workspace/repository-route-access";
import { getRunReplayPreview, queueRunReplay, RunReplayAccessError } from "@/lib/backend/workspace/run-replay";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";

export async function GET(
  request: Request,
  context: { params: Promise<{ owner: string; name: string; runId: string }> },
) {
  const requestId = createRequestId(request);
  const access = await requireApiRole("admin", request);

  if (access.denied) {
    return access.denied;
  }

  const { owner, name, runId } = await context.params;
  if (!(await hasRepositoryRouteAccess({ owner, name, workspaceId: access.workspaceSession.activeWorkspace.id }))) {
    return jsonWithRequestId({ message: "Run replay preview was not found." }, { status: 404 }, requestId);
  }

  try {
    const preview = await getRunReplayPreview(owner, name, access.workspaceSession.activeWorkspace.id, runId);
    if (!preview) {
      return jsonWithRequestId({ message: "Run replay preview was not found." }, { status: 404 }, requestId);
    }

    return jsonWithRequestId(preview, undefined, requestId);
  } catch (error) {
    logRouteError("repository_run_replay_get", requestId, error, {
      workspaceId: access.workspaceSession.activeWorkspace.id,
      owner,
      name,
      runId,
    });
    return jsonWithRequestId({ message: "Could not load run replay preview. Retry." }, { status: 500 }, requestId);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ owner: string; name: string; runId: string }> },
) {
  const requestId = createRequestId(request);
  const access = await requireApiRole("admin", request);

  if (access.denied) {
    return access.denied;
  }

  const { owner, name, runId } = await context.params;
  if (!(await hasRepositoryRouteAccess({ owner, name, workspaceId: access.workspaceSession.activeWorkspace.id }))) {
    return jsonWithRequestId({ message: "Run replay preview was not found." }, { status: 404 }, requestId);
  }

  try {
    const queued = await queueRunReplay(access.workspaceSession, owner, name, runId);
    if (!queued) {
      return jsonWithRequestId({ message: "Run replay preview was not found." }, { status: 404 }, requestId);
    }

    return jsonWithRequestId(queued, undefined, requestId);
  } catch (error) {
    if (error instanceof RunReplayAccessError) {
      return jsonWithRequestId({ message: error.message }, { status: error.statusCode }, requestId);
    }

    logRouteError("repository_run_replay_post", requestId, error, {
      workspaceId: access.workspaceSession.activeWorkspace.id,
      owner,
      name,
      runId,
    });
    return jsonWithRequestId({ message: "Could not queue run replay. Retry." }, { status: 500 }, requestId);
  }
}
