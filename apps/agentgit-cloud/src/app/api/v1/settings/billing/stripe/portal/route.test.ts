import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiRole = vi.fn();
const createWorkspaceStripePortal = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiRole,
}));

vi.mock("@/lib/backend/workspace/workspace-billing", () => ({
  createWorkspaceStripePortal,
}));

describe("billing stripe portal route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a Stripe customer portal URL for an authorized owner", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "owner" },
      },
    });
    createWorkspaceStripePortal.mockResolvedValue({
      url: "https://billing.stripe.test/session/bps_123",
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/v1/settings/billing/stripe/portal", { method: "POST" }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.url).toContain("billing.stripe.test");
  });
});
