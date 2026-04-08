import { requireApiRole } from "@/lib/auth/api-session";
import { ConnectorAccessError, queueConnectorCommand } from "@/lib/backend/control-plane/connectors";
import { readJsonBody, JsonBodyParseError } from "@/lib/http/request-body";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";
import { ConnectorCommandDispatchRequestSchema } from "@/schemas/cloud";

export async function POST(request: Request, context: { params: Promise<{ connectorId: string }> }) {
  const requestId = createRequestId(request);
  const access = await requireApiRole("admin", request);

  if (access.denied) {
    return access.denied;
  }

  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(request);
  } catch (error) {
    if (error instanceof JsonBodyParseError) {
      return jsonWithRequestId({ message: error.message }, { status: 400 }, requestId);
    }
    throw error;
  }
  const parsed = ConnectorCommandDispatchRequestSchema.safeParse(rawBody);

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
