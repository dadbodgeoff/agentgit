import { requireApiRole } from "@/lib/auth/api-session";
import { withWorkspaceAuthorityClient } from "@/lib/backend/authority/client";
import { ensureLocalControlPlaneStateInitialized } from "@/lib/backend/control-plane/state";
import { ensureLocalCloudStateInitialized } from "@/lib/backend/workspace/cloud-state.local";
import { hasDatabaseUrl, pingCloudDatabase } from "@/lib/db/client";
import { createRequestId, jsonWithRequestId } from "@/lib/observability/route-response";
import { getCloudReadinessChecks, summarizeOperationalHealth } from "@/lib/release/readiness";
import { getCloudRuntimeSummary } from "@/lib/release/runtime-config";
import { ensureLocalRateLimitStoreInitialized } from "@/lib/security/rate-limit";

export async function GET(request: Request): Promise<Response> {
  const requestId = createRequestId(request);
  const access = await requireApiRole("admin", request);

  if (access.denied) {
    return access.denied;
  }

  if (!hasDatabaseUrl()) {
    ensureLocalCloudStateInitialized();
    ensureLocalControlPlaneStateInitialized();
    ensureLocalRateLimitStoreInitialized();
  }

  const runtime = getCloudRuntimeSummary();
  const checks = getCloudReadinessChecks();
  const authority = await withWorkspaceAuthorityClient(access.workspaceSession.activeWorkspace.id, async () => ({
    level: "ok" as const,
    message: "Authority daemon responded successfully.",
  })).catch((_error) => ({
    level: "warn" as const,
    message: "Authority daemon did not respond to the readiness probe.",
  }));
  const database = await pingCloudDatabase()
    .then(() => ({
      level: "ok" as const,
      message: "Cloud database responded successfully.",
    }))
    .catch((_error) => ({
      level: "warn" as const,
      message: "Cloud database did not respond.",
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
      status: summarizeOperationalHealth(allChecks),
      checkedAt: new Date().toISOString(),
      runtime: {
        mode: runtime.mode,
        authConfigured: Boolean(runtime.authBaseUrl),
        workspaceRootsConfigured: runtime.workspaceRoots.length,
      },
      checks: allChecks,
    },
    undefined,
    requestId,
  );
}
