import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiRole = vi.fn();
const resolveWorkspaceIntegrations = vi.fn();
const saveWorkspaceIntegrations = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiRole,
}));

vi.mock("@/lib/backend/workspace/workspace-integrations", async () => {
  const actual = await vi.importActual<typeof import("@/lib/backend/workspace/workspace-integrations")>(
    "@/lib/backend/workspace/workspace-integrations",
  );

  return {
    ...actual,
    resolveWorkspaceIntegrations,
    saveWorkspaceIntegrations,
  };
});

describe("workspace integrations route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns integrations for an authorized admin", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "admin" },
      },
    });
    resolveWorkspaceIntegrations.mockResolvedValue({
      githubAppInstalled: true,
      githubAppStatus: "healthy",
      githubOrgName: "acme",
      webhookStatus: "healthy",
      webhookLastDeliveryAt: "2026-04-08T12:00:00Z",
      webhookFailureCount24h: 0,
      slackConnected: true,
      slackWebhookConfigured: true,
      slackWorkspaceName: "Acme",
      slackChannelName: "#ship-room",
      slackDeliveryMode: "all",
      emailNotificationsEnabled: true,
      digestCadence: "daily",
      notificationEvents: ["approval_requested"],
      notificationBusinessHours: {
        timeZone: "America/New_York",
        startTime: "09:00",
        endTime: "17:00",
        weekdays: ["mon", "tue", "wed", "thu", "fri"],
      },
      notificationRules: [],
    });

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/v1/settings/integrations"));
    expect(response.status).toBe(200);
  });

  it("returns a field-scoped validation error when Slack webhook validation fails", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "admin" },
      },
    });

    const { WorkspaceIntegrationValidationError } = await import("@/lib/backend/workspace/workspace-integrations");
    saveWorkspaceIntegrations.mockRejectedValue(
      new WorkspaceIntegrationValidationError("Slack webhook validation failed with 410. blocked", "slackWebhookUrl"),
    );

    const { PUT } = await import("./route");
    const response = await PUT(
      new Request("http://localhost/api/v1/settings/integrations", {
        method: "PUT",
        body: JSON.stringify({
          slackConnected: true,
          slackWebhookUrl: "https://hooks.slack.test/services/T000/B000/bad",
          slackWorkspaceName: "Acme",
          slackChannelName: "#ship-room",
          slackDeliveryMode: "all",
          emailNotificationsEnabled: true,
          digestCadence: "daily",
          notificationEvents: ["approval_requested"],
          notificationBusinessHours: {
            timeZone: "America/New_York",
            startTime: "09:00",
            endTime: "17:00",
            weekdays: ["mon", "tue", "wed", "thu", "fri"],
          },
          notificationRules: [],
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.field).toBe("slackWebhookUrl");
    expect(body.message).toContain("validation failed");
  });
});
