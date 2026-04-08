import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiRole = vi.fn();
const createWorkspaceStripeCheckout = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiRole,
}));

vi.mock("@/lib/backend/workspace/workspace-billing", async () => {
  const actual = await vi.importActual<typeof import("@/lib/backend/workspace/workspace-billing")>(
    "@/lib/backend/workspace/workspace-billing",
  );

  return {
    ...actual,
    createWorkspaceStripeCheckout,
  };
});

describe("billing stripe checkout route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a Stripe checkout URL for an authorized owner", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "owner" },
      },
    });
    createWorkspaceStripeCheckout.mockResolvedValue({
      url: "https://checkout.stripe.test/session/cs_test_123",
    });

    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/v1/settings/billing/stripe/checkout", { method: "POST" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.url).toContain("checkout.stripe.test");
  });

  it("returns a Stripe configuration error when checkout is unavailable", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "owner" },
      },
    });

    const { WorkspaceStripeConfigurationError } = await import("@/lib/backend/workspace/stripe-billing");
    createWorkspaceStripeCheckout.mockRejectedValue(
      new WorkspaceStripeConfigurationError("Stripe is not configured in this environment yet."),
    );

    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/v1/settings/billing/stripe/checkout", { method: "POST" }));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.message).toContain("Stripe is not configured");
  });
});
