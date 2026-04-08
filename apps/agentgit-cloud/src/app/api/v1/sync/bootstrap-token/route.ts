import { requireApiRole } from "@/lib/auth/api-session";
import {
  CONNECTOR_BOOTSTRAP_TOKEN_HEADER,
  issueConnectorBootstrapToken,
} from "@/lib/backend/control-plane/connectors";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";
import { enforceConnectorBootstrapTokenRateLimits } from "@/lib/security/rate-limit";

export async function POST(request: Request) {
  const requestId = createRequestId(request);
  const access = await requireApiRole("admin", request);

  if (access.denied) {
    return access.denied;
  }

  try {
    const rateLimited = await enforceConnectorBootstrapTokenRateLimits(request, access.workspaceSession.activeWorkspace.id);
    if (rateLimited) {
      return rateLimited;
    }

    const origin = new URL(request.url).origin;
    const token = issueConnectorBootstrapToken(access.workspaceSession, origin, new Date().toISOString());
    const { bootstrapToken, ...safeToken } = token;
    return jsonWithRequestId(
      safeToken,
      {
        headers: {
          [CONNECTOR_BOOTSTRAP_TOKEN_HEADER]: bootstrapToken,
        },
      },
      requestId,
    );
  } catch (error) {
    logRouteError("sync_bootstrap_token_post", requestId, error, {
      workspaceId: access.workspaceSession.activeWorkspace.id,
    });
    return jsonWithRequestId(
      { message: "Could not issue connector bootstrap token. Retry." },
      { status: 500 },
      requestId,
    );
  }
}
