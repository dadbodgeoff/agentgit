import { ConnectorCommandPullRequestSchema } from "@agentgit/cloud-sync-protocol";

import { requireConnectorSession } from "@/lib/auth/connector-session";
import { ConnectorAccessError, pullPendingConnectorCommands } from "@/lib/backend/control-plane/connectors";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";

export async function POST(request: Request) {
  const requestId = createRequestId(request);
  const connectorSession = requireConnectorSession(request);

  if (connectorSession.denied) {
    return connectorSession.denied;
  }

  const body = await request.json().catch(() => null);
  const parsed = ConnectorCommandPullRequestSchema.safeParse(body);

  if (!parsed.success) {
    return jsonWithRequestId(
      { message: "Connector command pull payload is invalid.", issues: parsed.error.flatten() },
      { status: 400 },
      requestId,
    );
  }

  try {
    const result = pullPendingConnectorCommands(connectorSession.access, parsed.data, new Date().toISOString());
    return jsonWithRequestId(result, undefined, requestId);
  } catch (error) {
    if (error instanceof ConnectorAccessError) {
      return jsonWithRequestId({ message: error.message }, { status: error.statusCode }, requestId);
    }

    logRouteError("sync_commands_pull_post", requestId, error, {
      connectorId: connectorSession.access.connector.id,
    });
    return jsonWithRequestId({ message: "Could not pull connector commands. Retry." }, { status: 500 }, requestId);
  }
}
