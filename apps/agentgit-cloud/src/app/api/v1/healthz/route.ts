import { ensureLocalControlPlaneStateInitialized } from "@/lib/backend/control-plane/state";
import { ensureLocalCloudStateInitialized } from "@/lib/backend/workspace/cloud-state.local";
import { hasDatabaseUrl, pingCloudDatabase } from "@/lib/db/client";
import { getCloudReadinessChecks, summarizeOperationalHealth } from "@/lib/release/readiness";
import { ensureLocalRateLimitStoreInitialized } from "@/lib/security/rate-limit";

type PublicHealthCheck = {
  id: string;
  level: "ok" | "warn" | "fail";
};

export async function GET(): Promise<Response> {
  if (!hasDatabaseUrl()) {
    ensureLocalCloudStateInitialized();
    ensureLocalControlPlaneStateInitialized();
    ensureLocalRateLimitStoreInitialized();
  }

  const checks = getCloudReadinessChecks();
  const database = await pingCloudDatabase()
    .then(
      () =>
        ({
          id: "cloud_database",
          level: "ok" as const,
        }) satisfies PublicHealthCheck,
    )
    .catch(
      () =>
        ({
          id: "cloud_database",
          level: "warn" as const,
        }) satisfies PublicHealthCheck,
    );

  const safeChecks: PublicHealthCheck[] = [
    ...checks.map((check) => ({
      id: check.id,
      level: check.level,
    })),
    database,
  ];
  const status = summarizeOperationalHealth(safeChecks);

  return Response.json(
    {
      service: "agentgit-cloud",
      status,
      checkedAt: new Date().toISOString(),
      checks: safeChecks,
    },
    {
      status: status === "fail" ? 503 : 200,
      headers: {
        "cache-control": "no-store",
      },
    },
  );
}
