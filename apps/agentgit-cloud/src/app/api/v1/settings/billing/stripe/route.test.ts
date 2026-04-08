import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiRole = vi.fn();
const resolveWorkspaceStripeBillingStatus = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiRole,
}));

vi.mock("@/lib/backend/workspace/workspace-billing", () => ({
  resolveWorkspaceStripeBillingStatus,
}));

describe("billing stripe status route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the live Stripe status for an authorized owner", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "owner" },
      },
    });
    resolveWorkspaceStripeBillingStatus.mockResolvedValue({
      checkoutEnabled: true,
      portalEnabled: false,
      provider: "beta_gate",
      message: "Stripe checkout is available for the current plan selection.",
    });

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/v1/settings/billing/stripe"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.checkoutEnabled).toBe(true);
    expect(body.provider).toBe("beta_gate");
  });
});
