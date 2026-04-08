import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiRole = vi.fn();
const resolveWorkspaceSettings = vi.fn();
const saveWorkspaceSettings = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiRole,
}));

vi.mock("@/lib/backend/workspace/workspace-settings", () => ({
  resolveWorkspaceSettings,
  saveWorkspaceSettings,
}));

vi.mock("@/lib/backend/workspace/cloud-state", () => ({
  findWorkspaceConnectionStateBySlug: vi.fn(() => null),
}));

describe("workspace settings route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns persisted settings for an authorized admin", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "admin" },
      },
    });
    resolveWorkspaceSettings.mockReturnValue({
      workspaceName: "Acme platform",
      workspaceSlug: "acme-platform",
      defaultNotificationChannel: "slack",
      approvalTtlMinutes: 30,
      requireRejectComment: true,
      freezeDeploysOutsideBusinessHours: false,
      enterpriseSso: {
        enabled: false,
        providerType: "oidc",
        providerLabel: "Enterprise SSO",
        issuerUrl: "https://idp.example.com/realms/agentgit",
        clientId: "agentgit-cloud",
        emailDomains: [],
        autoProvisionMembers: true,
        defaultRole: "member",
        clientSecretConfigured: false,
      },
    });

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/v1/settings/workspace"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.workspaceSlug).toBe("acme-platform");
    expect(response.headers.get("x-agentgit-request-id")).toBeTruthy();
  });

  it("returns a validation error for invalid payloads", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "admin" },
      },
    });

    const { PUT } = await import("./route");
    const response = await PUT(
      new Request("http://localhost/api/v1/settings/workspace", {
        method: "PUT",
        body: JSON.stringify({ workspaceName: "x" }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.message).toContain("invalid");
  });

  it("passes validated settings into the backend save flow", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "admin" },
      },
    });
    saveWorkspaceSettings.mockReturnValue({
      settings: {
        workspaceName: "Platform control",
        workspaceSlug: "platform-control",
        defaultNotificationChannel: "email",
        approvalTtlMinutes: 45,
        requireRejectComment: false,
        freezeDeploysOutsideBusinessHours: true,
        enterpriseSso: {
          enabled: true,
          providerType: "oidc",
          providerLabel: "Acme Okta",
          issuerUrl: "https://acme.okta.com/oauth2/default",
          clientId: "agentgit-cloud",
          emailDomains: ["acme.dev"],
          autoProvisionMembers: true,
          defaultRole: "member",
          clientSecretConfigured: true,
        },
      },
      savedAt: "2026-04-07T12:00:00Z",
      message: "Settings saved.",
    });

    const { PUT } = await import("./route");
    const response = await PUT(
      new Request("http://localhost/api/v1/settings/workspace", {
        method: "PUT",
        body: JSON.stringify({
          workspaceName: "Platform control",
          workspaceSlug: "platform-control",
          defaultNotificationChannel: "email",
          approvalTtlMinutes: 45,
          requireRejectComment: false,
          freezeDeploysOutsideBusinessHours: true,
          enterpriseSso: {
            enabled: true,
            providerType: "oidc",
            providerLabel: "Acme Okta",
            issuerUrl: "https://acme.okta.com/oauth2/default",
            clientId: "agentgit-cloud",
            clientSecret: "secret",
            emailDomains: ["acme.dev"],
            autoProvisionMembers: true,
            defaultRole: "member",
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(saveWorkspaceSettings).toHaveBeenCalled();
    expect(body.settings.workspaceName).toBe("Platform control");
  });
});
