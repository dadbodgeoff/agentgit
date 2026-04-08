import { ConnectorHeartbeatRequestSchema } from "@agentgit/cloud-sync-protocol";

import { requireConnectorSession } from "@/lib/auth/connector-session";
import { ConnectorAccessError, recordConnectorHeartbeat } from "@/lib/backend/control-plane/connectors";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";

export async function POST(request: Request) {
  const requestId = createRequestId(request);
  const connectorSession = await requireConnectorSession(request);

  if (connectorSession.denied) {
    return connectorSession.denied;
  }

  const body = await request.json().catch(() => null);
  const parsed = ConnectorHeartbeatRequestSchema.safeParse(body);

  if (!parsed.success) {
    return jsonWithRequestId(
      { message: "Connector heartbeat payload is invalid.", issues: parsed.error.flatten() },
      { status: 400 },
      requestId,
    );
  }

  try {
    const result = recordConnectorHeartbeat(connectorSession.access, parsed.data, new Date().toISOString());
    return jsonWithRequestId(result, undefined, requestId);
  } catch (error) {
    if (error instanceof ConnectorAccessError) {
      return jsonWithRequestId({ message: error.message }, { status: error.statusCode }, requestId);
    }

    logRouteError("sync_heartbeat_post", requestId, error, {
      connectorId: connectorSession.access.connector.id,
    });
    return jsonWithRequestId({ message: "Could not record connector heartbeat. Retry." }, { status: 500 }, requestId);
  }
}
