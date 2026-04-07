import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiSession = vi.fn();
const withWorkspaceAuthorityClient = vi.fn();
const mapResolvedApprovalToCloud = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiSession,
}));

vi.mock("@/lib/backend/authority/client", () => ({
  withWorkspaceAuthorityClient,
}));

vi.mock("@/lib/backend/authority/contracts", () => ({
  mapResolvedApprovalToCloud,
}));

describe("approval decision routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireApiSession.mockResolvedValue({
      session: {
        user: { email: "jordan@acme.dev", name: "Jordan Smith" },
      },
      unauthorized: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "admin" },
      },
    });
    mapResolvedApprovalToCloud.mockReturnValue({ id: "appr_01", status: "approved" });
  });

  it("returns 400 for malformed approval payloads instead of calling the authority client", async () => {
    const { POST } = await import("./[id]/approve/route");
    const response = await POST(
      new Request("http://localhost/api/v1/approvals/appr_01/approve", {
        body: JSON.stringify({ comment: 42 }),
        method: "POST",
      }),
      { params: Promise.resolve({ id: "appr_01" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.message).toContain("invalid");
    expect(withWorkspaceAuthorityClient).not.toHaveBeenCalled();
  });

  it("scopes rejection decisions to the active workspace", async () => {
    withWorkspaceAuthorityClient.mockImplementation(async (_workspaceId, run) =>
      run({
        resolveApproval: vi.fn().mockResolvedValue({ approval_request: { approval_id: "appr_01" } }),
      }),
    );

    const { POST } = await import("./[id]/reject/route");
    const response = await POST(
      new Request("http://localhost/api/v1/approvals/appr_01/reject", {
        body: JSON.stringify({ comment: "Too risky" }),
        method: "POST",
      }),
      { params: Promise.resolve({ id: "appr_01" }) },
    );

    expect(response.status).toBe(200);
    expect(withWorkspaceAuthorityClient).toHaveBeenCalledWith("ws_acme_01", expect.any(Function));
  });
});
