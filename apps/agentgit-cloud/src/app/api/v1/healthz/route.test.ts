import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db/client", () => ({
  pingCloudDatabase: vi.fn(async () => undefined),
}));

vi.mock("@/lib/release/readiness", () => ({
  getCloudReadinessChecks: vi.fn(() => [
    { id: "auth_secret", level: "ok", message: "ok" },
    { id: "uptime_monitoring", level: "ok", message: "ok" },
  ]),
  summarizeReadiness: vi.fn(() => "ok"),
}));

describe("public healthz route", () => {
  it("returns a public readiness summary without requiring a workspace session", async () => {
    const { GET } = await import("./route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.service).toBe("agentgit-cloud");
    expect(body.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "auth_secret", level: "ok" }),
        expect.objectContaining({ id: "cloud_database", level: "ok" }),
      ]),
    );
  });
});
