import { pingCloudDatabase } from "@/lib/db/client";
import { getCloudReadinessChecks, summarizeReadiness } from "@/lib/release/readiness";

type PublicHealthCheck = {
  id: string;
  level: "ok" | "warn" | "fail";
};

export async function GET(): Promise<Response> {
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
  const status = summarizeReadiness(safeChecks);

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
