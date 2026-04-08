import { requireApiRole } from "@/lib/auth/api-session";
import { ConnectorAccessError, retryConnectorCommand } from "@/lib/backend/control-plane/connectors";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";

export async function POST(request: Request, context: { params: Promise<{ commandId: string }> }) {
  const requestId = createRequestId(request);
  const access = await requireApiRole("admin", request);

  if (access.denied) {
    return access.denied;
  }

  const { commandId } = await context.params;

  try {
    return jsonWithRequestId(
      retryConnectorCommand(access.workspaceSession.activeWorkspace.id, commandId, new Date().toISOString()),
      undefined,
      requestId,
    );
  } catch (error) {
    if (error instanceof ConnectorAccessError) {
      return jsonWithRequestId({ message: error.message }, { status: error.statusCode }, requestId);
    }

    logRouteError("sync_command_retry_post", requestId, error, {
      workspaceId: access.workspaceSession.activeWorkspace.id,
      commandId,
    });
    return jsonWithRequestId({ message: "Could not retry the connector command. Retry." }, { status: 500 }, requestId);
  }
}
