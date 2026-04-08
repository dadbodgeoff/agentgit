import { requireApiRole } from "@/lib/auth/api-session";
import { issueConnectorBootstrapToken } from "@/lib/backend/control-plane/connectors";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";

export async function POST(request: Request) {
  const requestId = createRequestId(request);
  const access = await requireApiRole("admin", request);

  if (access.denied) {
    return access.denied;
  }

  try {
    const origin = new URL(request.url).origin;
    const token = issueConnectorBootstrapToken(access.workspaceSession, origin, new Date().toISOString());
    return jsonWithRequestId(token, undefined, requestId);
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
