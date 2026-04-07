import { ConnectorEventBatchRequestSchema } from "@agentgit/cloud-sync-protocol";

import { requireConnectorSession } from "@/lib/auth/connector-session";
import { ConnectorAccessError, ingestConnectorEvents } from "@/lib/backend/control-plane/connectors";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";

export async function POST(request: Request) {
  const requestId = createRequestId(request);
  const connectorSession = requireConnectorSession(request);

  if (connectorSession.denied) {
    return connectorSession.denied;
  }

  const body = await request.json().catch(() => null);
  const parsed = ConnectorEventBatchRequestSchema.safeParse(body);

  if (!parsed.success) {
    return jsonWithRequestId(
      { message: "Connector event batch payload is invalid.", issues: parsed.error.flatten() },
      { status: 400 },
      requestId,
    );
  }

  try {
    const result = ingestConnectorEvents(connectorSession.access, parsed.data, new Date().toISOString());
    return jsonWithRequestId(result, undefined, requestId);
  } catch (error) {
    if (error instanceof ConnectorAccessError) {
      return jsonWithRequestId({ message: error.message }, { status: error.statusCode }, requestId);
    }

    logRouteError("sync_events_post", requestId, error, {
      connectorId: connectorSession.access.connector.id,
    });
    return jsonWithRequestId({ message: "Could not ingest connector events. Retry." }, { status: 500 }, requestId);
  }
}
