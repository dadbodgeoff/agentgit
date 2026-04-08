import { requireApiRole } from "@/lib/auth/api-session";
import { ConnectorAccessError, revokeWorkspaceConnector } from "@/lib/backend/control-plane/connectors";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";

export async function DELETE(request: Request, context: { params: Promise<{ connectorId: string }> }) {
  const requestId = createRequestId(request);
  const access = await requireApiRole("admin", request);

  if (access.denied) {
    return access.denied;
  }

  const { connectorId } = await context.params;

  try {
    return jsonWithRequestId(
      revokeWorkspaceConnector(access.workspaceSession.activeWorkspace.id, connectorId, new Date().toISOString()),
      undefined,
      requestId,
    );
  } catch (error) {
    if (error instanceof ConnectorAccessError) {
      return jsonWithRequestId({ message: error.message }, { status: error.statusCode }, requestId);
    }

    logRouteError("sync_connector_delete", requestId, error, {
      workspaceId: access.workspaceSession.activeWorkspace.id,
      connectorId,
    });
    return jsonWithRequestId({ message: "Could not revoke connector access. Retry." }, { status: 500 }, requestId);
  }
}
