import { requireApiRole } from "@/lib/auth/api-session";
import { withWorkspaceAuthorityClient } from "@/lib/backend/authority/client";
import { createRequestId, jsonWithRequestId } from "@/lib/observability/route-response";
import { getCloudReadinessChecks, summarizeReadiness } from "@/lib/release/readiness";

export async function GET(request: Request): Promise<Response> {
  const requestId = createRequestId(request);
  const access = await requireApiRole("admin");

  if (access.denied) {
    return access.denied;
  }

  const checks = getCloudReadinessChecks();
  const authority = await withWorkspaceAuthorityClient(access.workspaceSession.activeWorkspace.id, async () => ({
    level: "ok" as const,
    message: "Authority daemon responded successfully.",
  })).catch((error) => ({
    level: "warn" as const,
    message:
      error instanceof Error && error.message.length > 0
        ? error.message
        : "Authority daemon did not respond to the readiness probe.",
  }));

  const allChecks = [
    ...checks,
    {
      id: "authority_daemon",
      level: authority.level,
      message: authority.message,
    },
  ];

  return jsonWithRequestId(
    {
      status: summarizeReadiness(allChecks),
      checkedAt: new Date().toISOString(),
      workspaceId: access.workspaceSession.activeWorkspace.id,
      checks: allChecks,
    },
    undefined,
    requestId,
  );
}
