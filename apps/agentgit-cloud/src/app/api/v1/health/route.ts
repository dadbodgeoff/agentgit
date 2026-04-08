import { requireApiRole } from "@/lib/auth/api-session";
import { withWorkspaceAuthorityClient } from "@/lib/backend/authority/client";
import { pingCloudDatabase } from "@/lib/db/client";
import { createRequestId, jsonWithRequestId } from "@/lib/observability/route-response";
import { getCloudReadinessChecks, summarizeReadiness } from "@/lib/release/readiness";
import { getCloudRuntimeSummary } from "@/lib/release/runtime-config";

export async function GET(request: Request): Promise<Response> {
  const requestId = createRequestId(request);
  const access = await requireApiRole("admin", request);

  if (access.denied) {
    return access.denied;
  }

  const runtime = getCloudRuntimeSummary();
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
  const database = await pingCloudDatabase()
    .then(() => ({
      level: "ok" as const,
      message: "Cloud database responded successfully.",
    }))
    .catch((error) => ({
      level: "warn" as const,
      message: error instanceof Error && error.message.length > 0 ? error.message : "Cloud database did not respond.",
    }));

  const allChecks = [
    ...checks,
    {
      id: "cloud_database",
      level: database.level,
      message: database.message,
    },
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
      runtime: {
        mode: runtime.mode,
        authBaseUrl: runtime.authBaseUrl,
        agentgitRoot: runtime.agentgitRoot,
        workspaceRoots: runtime.workspaceRoots,
      },
      checks: allChecks,
    },
    undefined,
    requestId,
  );
}
