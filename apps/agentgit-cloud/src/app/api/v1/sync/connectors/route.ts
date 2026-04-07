import { requireApiRole } from "@/lib/auth/api-session";
import { listWorkspaceConnectors } from "@/lib/backend/control-plane/connectors";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";

export async function GET(request: Request) {
  const requestId = createRequestId(request);
  const access = await requireApiRole("admin");

  if (access.denied) {
    return access.denied;
  }

  try {
    return jsonWithRequestId(
      listWorkspaceConnectors(access.workspaceSession.activeWorkspace.id, new Date().toISOString()),
      undefined,
      requestId,
    );
  } catch (error) {
    logRouteError("sync_connectors_get", requestId, error, {
      workspaceId: access.workspaceSession.activeWorkspace.id,
    });
    return jsonWithRequestId({ message: "Could not load workspace connectors. Retry." }, { status: 500 }, requestId);
  }
}
