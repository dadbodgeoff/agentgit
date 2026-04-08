import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const requireApiRole = vi.fn();
const registerConnector = vi.fn();
const enforceConnectorRegistrationRateLimits = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiRole,
}));

vi.mock("@/lib/security/rate-limit", () => ({
  enforceConnectorRegistrationRateLimits,
}));

vi.mock("@/lib/backend/control-plane/connectors", () => ({
  registerConnector,
}));

describe("sync register route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enforceConnectorRegistrationRateLimits.mockResolvedValue(null);
  });

  it("registers a connector for the active workspace", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        activeWorkspace: {
          id: "ws_acme_01",
          name: "Acme",
          slug: "acme",
          role: "admin",
        },
      },
    });
    registerConnector.mockReturnValue({
      schemaVersion: "cloud-sync.v1",
      connector: {
        id: "conn_01",
      },
      accessToken: "agcs_test",
      issuedAt: "2026-04-07T18:00:00Z",
      expiresAt: "2026-05-07T18:00:00Z",
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/v1/sync/register", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: "ws_acme_01",
          connectorName: "MacBook connector",
          machineName: "geoffrey-mbp",
          connectorVersion: "0.1.0",
          platform: {
            os: "darwin",
            arch: "arm64",
            hostname: "geoffrey-mbp",
          },
          capabilities: ["repo_state_sync"],
          repository: {
            provider: "github",
            repo: {
              owner: "acme",
              name: "platform-ui",
            },
            remoteUrl: "git@github.com:acme/platform-ui.git",
            defaultBranch: "main",
            currentBranch: "main",
            headSha: "abcdef1234567",
            isDirty: false,
            aheadBy: 0,
            behindBy: 0,
            workspaceRoot: "/Users/me/code/platform-ui",
            lastFetchedAt: null,
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(registerConnector).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_acme_01",
        machineName: "geoffrey-mbp",
      }),
      expect.objectContaining({
        id: "ws_acme_01",
        slug: "acme",
      }),
      expect.any(String),
    );
    expect(body.accessToken).toBe("agcs_test");
  });

  it("returns 429 when connector registration is rate limited", async () => {
    enforceConnectorRegistrationRateLimits.mockResolvedValue(
      NextResponse.json({ message: "Too many connector registration attempts. Retry in a minute." }, { status: 429 }),
    );

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/v1/sync/register", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: "ws_acme_01",
          connectorName: "MacBook connector",
          machineName: "geoffrey-mbp",
          connectorVersion: "0.1.0",
          platform: {
            os: "darwin",
            arch: "arm64",
            hostname: "geoffrey-mbp",
          },
          capabilities: ["repo_state_sync"],
          repository: {
            provider: "github",
            repo: {
              owner: "acme",
              name: "platform-ui",
            },
            remoteUrl: "git@github.com:acme/platform-ui.git",
            defaultBranch: "main",
            currentBranch: "main",
            headSha: "abcdef1234567",
            isDirty: false,
            aheadBy: 0,
            behindBy: 0,
            workspaceRoot: "/Users/me/code/platform-ui",
            lastFetchedAt: null,
          },
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(requireApiRole).not.toHaveBeenCalled();
    expect(registerConnector).not.toHaveBeenCalled();
    expect(body.message).toContain("Too many connector registration attempts");
  });
});
