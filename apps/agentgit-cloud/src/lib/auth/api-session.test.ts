import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  enforceApiRateLimits: vi.fn(),
  resolveWorkspaceSession: vi.fn(),
}));

vi.mock("@/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/auth/workspace-session", () => ({
  resolveWorkspaceSession: mocks.resolveWorkspaceSession,
}));

vi.mock("@/lib/security/rate-limit", () => ({
  enforceApiRateLimits: mocks.enforceApiRateLimits,
}));

import { requireApiSession } from "@/lib/auth/api-session";
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "@/lib/security/csrf";

const workspaceSession = {
  user: {
    id: "usr_test",
    name: "Test User",
    email: "test@agentgit.dev",
  },
  activeWorkspace: {
    id: "ws_test",
    name: "Test",
    slug: "test",
    role: "admin",
  },
};

describe("requireApiSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("requires CSRF validation for browser-authenticated state-changing requests", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "usr_test" } });
    mocks.resolveWorkspaceSession.mockResolvedValue(workspaceSession);
    mocks.enforceApiRateLimits.mockResolvedValue(null);

    const denied = await requireApiSession(
      new Request("http://localhost/api/v1/settings/workspace", {
        method: "PUT",
        headers: {
          origin: "http://localhost",
        },
      }),
    );

    expect(denied.unauthorized?.status).toBe(403);
    await expect(denied.unauthorized?.json()).resolves.toEqual({ message: "CSRF token is missing or invalid." });
    expect(mocks.enforceApiRateLimits).not.toHaveBeenCalled();
  });

  it("allows state-changing requests with matching CSRF cookie and header", async () => {
    const csrfToken = "csrf-token-test";
    mocks.auth.mockResolvedValue({ user: { id: "usr_test" } });
    mocks.resolveWorkspaceSession.mockResolvedValue(workspaceSession);
    mocks.enforceApiRateLimits.mockResolvedValue(null);

    const access = await requireApiSession(
      new Request("http://localhost/api/v1/settings/workspace", {
        method: "PUT",
        headers: {
          cookie: `${CSRF_COOKIE_NAME}=${csrfToken}`,
          origin: "http://localhost",
          [CSRF_HEADER_NAME]: csrfToken,
        },
      }),
    );

    expect(access.unauthorized).toBeNull();
    expect(mocks.enforceApiRateLimits).toHaveBeenCalledWith(expect.any(Request), "ws_test");
  });
});
