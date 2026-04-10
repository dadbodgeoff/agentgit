import { ConnectorEventBatchRequestSchema } from "@agentgit/cloud-sync-protocol";

import { requireConnectorSession } from "@/lib/auth/connector-session";
import { ConnectorAccessError, ingestConnectorEvents } from "@/lib/backend/control-plane/connectors";
import {
  buildCloudSyncSchemaVersionErrorMessage,
  hasExpectedCloudSyncSchemaVersion,
} from "@/lib/http/cloud-sync-version";
import { readJsonBody, JsonBodyParseError, JsonBodyTooLargeError } from "@/lib/http/request-body";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";

const MAX_EVENT_BATCH_BODY_BYTES = 1_000_000;

export async function POST(request: Request) {
  const requestId = createRequestId(request);
  const connectorSession = await requireConnectorSession(request);

  if (connectorSession.denied) {
    return connectorSession.denied;
  }

  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(request, { maxBytes: MAX_EVENT_BATCH_BODY_BYTES });
  } catch (error) {
    if (error instanceof JsonBodyTooLargeError) {
      return jsonWithRequestId({ message: "Connector event batch payload is too large." }, { status: 413 }, requestId);
    }

    if (error instanceof JsonBodyParseError) {
      return jsonWithRequestId({ message: error.message }, { status: 400 }, requestId);
    }

    throw error;
  }

  if (!hasExpectedCloudSyncSchemaVersion(rawBody)) {
    return jsonWithRequestId({ message: buildCloudSyncSchemaVersionErrorMessage() }, { status: 400 }, requestId);
  }

  const parsed = ConnectorEventBatchRequestSchema.safeParse(rawBody);

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
