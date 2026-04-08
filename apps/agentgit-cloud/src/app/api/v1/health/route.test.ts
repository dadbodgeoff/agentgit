import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiRole = vi.fn();
const withWorkspaceAuthorityClient = vi.fn();
const pingCloudDatabase = vi.fn(async () => undefined);
const hasDatabaseUrl = vi.fn(() => false);
const ensureLocalCloudStateInitialized = vi.fn();
const ensureLocalControlPlaneStateInitialized = vi.fn();
const ensureLocalRateLimitStoreInitialized = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiRole,
}));

vi.mock("@/lib/backend/authority/client", () => ({
  withWorkspaceAuthorityClient,
}));

vi.mock("@/lib/db/client", () => ({
  hasDatabaseUrl,
  pingCloudDatabase,
}));

vi.mock("@/lib/backend/workspace/cloud-state.local", () => ({
  ensureLocalCloudStateInitialized,
}));

vi.mock("@/lib/backend/control-plane/state", () => ({
  ensureLocalControlPlaneStateInitialized,
}));

vi.mock("@/lib/security/rate-limit", () => ({
  ensureLocalRateLimitStoreInitialized,
}));

vi.mock("@/lib/release/readiness", () => ({
  getCloudReadinessChecks: vi.fn(() => []),
  summarizeOperationalHealth: vi.fn(() => "ok"),
}));

describe("health route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("probes authority readiness with the active workspace scope", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "admin" },
      },
    });
    withWorkspaceAuthorityClient.mockImplementation(async (_workspaceId, run) => run({}));

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/v1/health"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(withWorkspaceAuthorityClient).toHaveBeenCalledWith("ws_acme_01", expect.any(Function));
    expect(ensureLocalCloudStateInitialized).toHaveBeenCalled();
    expect(ensureLocalControlPlaneStateInitialized).toHaveBeenCalled();
    expect(ensureLocalRateLimitStoreInitialized).toHaveBeenCalled();
    expect(body.workspaceId).toBeUndefined();
  });
});
