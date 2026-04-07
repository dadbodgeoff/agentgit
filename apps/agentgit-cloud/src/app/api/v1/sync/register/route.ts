import { requireApiRole } from "@/lib/auth/api-session";
import { getBearerToken } from "@/lib/auth/connector-session";
import {
  ConnectorAccessError,
  registerConnector,
  registerConnectorWithBootstrapToken,
} from "@/lib/backend/control-plane/connectors";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";
import { ConnectorRegistrationRequestSchema } from "@agentgit/cloud-sync-protocol";

export async function POST(request: Request) {
  const requestId = createRequestId(request);
  const body = await request.json().catch(() => null);
  const parsed = ConnectorRegistrationRequestSchema.safeParse(body);

  if (!parsed.success) {
    return jsonWithRequestId(
      { message: "Connector registration payload is invalid.", issues: parsed.error.flatten() },
      { status: 400 },
      requestId,
    );
  }

  try {
    const bootstrapToken = getBearerToken(request);
    const now = new Date().toISOString();
    const registration = bootstrapToken
      ? registerConnectorWithBootstrapToken(parsed.data, bootstrapToken, now)
      : await (async () => {
          const access = await requireApiRole("admin");
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
    return jsonWithRequestId(registration, undefined, requestId);
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
