import { afterEach, describe, expect, it, vi } from "vitest";

describe("cloud runtime production readiness", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("fails production readiness when required telemetry and analytics controls are missing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AGENTGIT_ROOT", process.cwd());

    const { getCloudRuntimeChecks } = await import("@/lib/release/runtime-config");
    const checks = getCloudRuntimeChecks();

    expect(checks.find((check) => check.id === "sentry_dsn")?.level).toBe("fail");
    expect(checks.find((check) => check.id === "sentry_source_maps")?.level).toBe("fail");
    expect(checks.find((check) => check.id === "vercel_analytics")?.level).toBe("fail");
  });
});
