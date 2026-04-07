import { requireApiRole } from "@/lib/auth/api-session";
import { ConnectorAccessError, queueConnectorCommand } from "@/lib/backend/control-plane/connectors";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";
import { ConnectorCommandDispatchRequestSchema } from "@/schemas/cloud";

export async function POST(
  request: Request,
  context: { params: Promise<{ connectorId: string }> },
) {
  const requestId = createRequestId(request);
  const access = await requireApiRole("admin");

  if (access.denied) {
    return access.denied;
  }

  const body = await request.json().catch(() => null);
  const parsed = ConnectorCommandDispatchRequestSchema.safeParse(body);

  if (!parsed.success) {
    return jsonWithRequestId(
      { message: "Connector command payload is invalid.", issues: parsed.error.flatten() },
      { status: 400 },
      requestId,
    );
  }

  const { connectorId } = await context.params;

  try {
    return jsonWithRequestId(
      queueConnectorCommand(access.workspaceSession, connectorId, parsed.data, new Date().toISOString()),
      undefined,
      requestId,
    );
  } catch (error) {
    if (error instanceof ConnectorAccessError) {
      return jsonWithRequestId({ message: error.message }, { status: error.statusCode }, requestId);
    }

    logRouteError("sync_connector_command_post", requestId, error, {
      workspaceId: access.workspaceSession.activeWorkspace.id,
      connectorId,
      commandType: parsed.data.type,
    });
    return jsonWithRequestId({ message: "Could not queue connector command. Retry." }, { status: 500 }, requestId);
  }
}
