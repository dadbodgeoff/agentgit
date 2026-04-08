import { ConnectorCommandAckRequestSchema } from "@agentgit/cloud-sync-protocol";

import { requireConnectorSession } from "@/lib/auth/connector-session";
import { ConnectorAccessError, acknowledgeConnectorCommand } from "@/lib/backend/control-plane/connectors";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";

export async function POST(request: Request, context: { params: Promise<{ commandId: string }> }) {
  const requestId = createRequestId(request);
  const connectorSession = await requireConnectorSession(request);

  if (connectorSession.denied) {
    return connectorSession.denied;
  }

  const body = await request.json().catch(() => null);
  const parsed = ConnectorCommandAckRequestSchema.safeParse(body);

  if (!parsed.success) {
    return jsonWithRequestId(
      { message: "Connector command acknowledgement payload is invalid.", issues: parsed.error.flatten() },
      { status: 400 },
      requestId,
    );
  }

  const { commandId } = await context.params;
  if (parsed.data.commandId !== commandId) {
    return jsonWithRequestId(
      { message: "Connector command acknowledgement route did not match the payload command id." },
      { status: 400 },
      requestId,
    );
  }

  try {
    return jsonWithRequestId(
      acknowledgeConnectorCommand(connectorSession.access, parsed.data, new Date().toISOString()),
      undefined,
      requestId,
    );
  } catch (error) {
    if (error instanceof ConnectorAccessError) {
      return jsonWithRequestId({ message: error.message }, { status: error.statusCode }, requestId);
    }

    logRouteError("sync_command_ack_post", requestId, error, {
      connectorId: connectorSession.access.connector.id,
      commandId,
    });
    return jsonWithRequestId(
      { message: "Could not acknowledge connector command. Retry." },
      { status: 500 },
      requestId,
    );
  }
}
