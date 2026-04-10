import { requireApiRole } from "@/lib/auth/api-session";
import { getBearerToken } from "@/lib/auth/connector-session";
import {
  CONNECTOR_ACCESS_TOKEN_HEADER,
  ConnectorAccessError,
  registerConnector,
  registerConnectorWithBootstrapToken,
} from "@/lib/backend/control-plane/connectors";
import {
  buildCloudSyncSchemaVersionErrorMessage,
  hasExpectedCloudSyncSchemaVersion,
} from "@/lib/http/cloud-sync-version";
import { readJsonBody, JsonBodyParseError } from "@/lib/http/request-body";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";
import { enforceConnectorRegistrationRateLimits } from "@/lib/security/rate-limit";
import { ConnectorRegistrationRequestSchema } from "@agentgit/cloud-sync-protocol";

export async function POST(request: Request) {
  const requestId = createRequestId(request);
  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(request);
  } catch (error) {
    if (error instanceof JsonBodyParseError) {
      return jsonWithRequestId({ message: error.message }, { status: 400 }, requestId);
    }
    throw error;
  }
  if (!hasExpectedCloudSyncSchemaVersion(rawBody)) {
    return jsonWithRequestId({ message: buildCloudSyncSchemaVersionErrorMessage() }, { status: 400 }, requestId);
  }
  const parsed = ConnectorRegistrationRequestSchema.safeParse(rawBody);

  if (!parsed.success) {
    return jsonWithRequestId(
      { message: "Connector registration payload is invalid.", issues: parsed.error.flatten() },
      { status: 400 },
      requestId,
    );
  }

  try {
    const rateLimited = await enforceConnectorRegistrationRateLimits(request, parsed.data.workspaceId);
    if (rateLimited) {
      return rateLimited;
    }

    const bootstrapToken = getBearerToken(request);
    const now = new Date().toISOString();
    const registration = bootstrapToken
      ? registerConnectorWithBootstrapToken(parsed.data, bootstrapToken, now)
      : await (async () => {
          const access = await requireApiRole("admin", request);
          if (access.denied) {
            throw access.denied;
          }

          if (parsed.data.workspaceId !== access.workspaceSession.activeWorkspace.id) {
            throw new ConnectorAccessError(
              "Connector registration workspace scope did not match the active workspace.",
              403,
            );
          }

          return registerConnector(
            parsed.data,
            {
              id: access.workspaceSession.activeWorkspace.id,
              slug: access.workspaceSession.activeWorkspace.slug,
            },
            now,
          );
        })();
    const { accessToken, ...safeRegistration } = registration;
    return jsonWithRequestId(
      safeRegistration,
      {
        headers: {
          [CONNECTOR_ACCESS_TOKEN_HEADER]: accessToken,
        },
      },
      requestId,
    );
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    if (error instanceof ConnectorAccessError) {
      return jsonWithRequestId({ message: error.message }, { status: error.statusCode }, requestId);
    }
    logRouteError("sync_register_post", requestId, error, {
      workspaceId: parsed.data.workspaceId,
      machineName: parsed.data.machineName,
    });
    return jsonWithRequestId({ message: "Could not register connector. Retry." }, { status: 500 }, requestId);
  }
}
