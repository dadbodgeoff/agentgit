import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiRole = vi.fn();
const exportWorkspaceAuditLog = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiRole,
}));

vi.mock("@/lib/backend/workspace/audit-log", () => ({
  exportWorkspaceAuditLog,
}));

describe("audit export route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a downloadable export for the active workspace", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", slug: "acme", role: "admin" },
      },
    });
    exportWorkspaceAuditLog.mockResolvedValue({
      contentType: "text/csv; charset=utf-8",
      fileName: "audit-ws_acme_01-test.csv",
      body: "id,occurredAt\nappr_01,2026-04-07T10:05:00Z\n",
    });

    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        "http://localhost/api/v1/audit/export?format=csv&from=2026-04-07T00:00:00.000Z&to=2026-04-08T23:59:59.999Z",
      ),
    );
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(exportWorkspaceAuditLog).toHaveBeenCalledWith("ws_acme_01", "csv", {
      from: "2026-04-07T00:00:00.000Z",
      to: "2026-04-08T23:59:59.999Z",
      limit: 5000,
    });
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain("audit-ws_acme_01-test.csv");
    expect(body).toContain("appr_01");
  });

  it("rejects invalid export query ranges", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", slug: "acme", role: "admin" },
      },
    });

    const { GET } = await import("./route");
    const response = await GET(
      new Request(
        "http://localhost/api/v1/audit/export?format=json&from=2026-04-09T00:00:00.000Z&to=2026-04-08T00:00:00.000Z",
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.message).toBe("Invalid audit export parameters.");
  });
});
