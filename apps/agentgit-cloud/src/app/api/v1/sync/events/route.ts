import { ConnectorEventBatchRequestSchema } from "@agentgit/cloud-sync-protocol";

import { requireConnectorSession } from "@/lib/auth/connector-session";
import { ConnectorAccessError, ingestConnectorEvents } from "@/lib/backend/control-plane/connectors";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";

const MAX_EVENT_BATCH_BODY_BYTES = 1_000_000;

export async function POST(request: Request) {
  const requestId = createRequestId(request);
  const connectorSession = await requireConnectorSession(request);

  if (connectorSession.denied) {
    return connectorSession.denied;
  }

  const contentLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_EVENT_BATCH_BODY_BYTES) {
    return jsonWithRequestId(
      { message: "Connector event batch payload is too large." },
      { status: 413 },
      requestId,
    );
  }

  const rawBody = await request.text().catch(() => "");
  if (Buffer.byteLength(rawBody, "utf8") > MAX_EVENT_BATCH_BODY_BYTES) {
    return jsonWithRequestId(
      { message: "Connector event batch payload is too large." },
      { status: 413 },
      requestId,
    );
  }

  const body = (() => {
    try {
      return rawBody.length > 0 ? JSON.parse(rawBody) : null;
    } catch {
      return null;
    }
  })();
  const parsed = ConnectorEventBatchRequestSchema.safeParse(body);

  if (!parsed.success) {
    return jsonWithRequestId(
      { message: "Connector event batch payload is invalid.", issues: parsed.error.flatten() },
      { status: 400 },
      requestId,
    );
  }

  try {
    const result = await ingestConnectorEvents(connectorSession.access, parsed.data, new Date().toISOString());
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
