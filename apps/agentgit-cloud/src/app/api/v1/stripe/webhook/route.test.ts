import { beforeEach, describe, expect, it, vi } from "vitest";

const handleWorkspaceStripeWebhook = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/backend/workspace/workspace-billing", () => ({
  handleWorkspaceStripeWebhook,
}));

describe("stripe webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects webhook calls without a Stripe signature header", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/v1/stripe/webhook", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.message).toContain("signature");
  });

  it("passes the raw body and signature into the webhook handler", async () => {
    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/v1/stripe/webhook", {
        method: "POST",
        headers: {
          "stripe-signature": "t=1,v1=test",
          "content-type": "application/json",
        },
        body: JSON.stringify({ id: "evt_test" }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.received).toBe(true);
    expect(handleWorkspaceStripeWebhook).toHaveBeenCalledWith('{"id":"evt_test"}', "t=1,v1=test");
  });
});
