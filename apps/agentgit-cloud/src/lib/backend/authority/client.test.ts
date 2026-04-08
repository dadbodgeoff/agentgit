import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/backend/workspace/repository-inventory", () => ({
  collectWorkspaceRepositoryRuntimeRecords: vi.fn(),
}));
vi.mock("@/lib/backend/workspace/roots", () => ({
  resolveWorkspaceRoots: vi.fn(),
}));

async function loadModule() {
  return import("@/lib/backend/authority/client");
}

describe("resolveAuthoritySocketPath", () => {
  beforeEach(async () => {
    const { collectWorkspaceRepositoryRuntimeRecords } = await import("@/lib/backend/workspace/repository-inventory");
    const { resolveWorkspaceRoots } = await import("@/lib/backend/workspace/roots");

    vi.mocked(collectWorkspaceRepositoryRuntimeRecords).mockReset();
    vi.mocked(resolveWorkspaceRoots).mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers an explicit AGENTGIT_SOCKET_PATH override", () => {
    vi.stubEnv("AGENTGIT_SOCKET_PATH", "/tmp/agentgit/custom-authority.sock");

    return loadModule().then(({ resolveAuthoritySocketPath }) => {
      expect(resolveAuthoritySocketPath(["/workspace/repo"])).toBe("/tmp/agentgit/custom-authority.sock");
    });
  });

  it("derives the socket from the first configured workspace root", () => {
    return loadModule().then(({ resolveAuthoritySocketPath }) => {
      expect(resolveAuthoritySocketPath(["/workspace/repo", "/workspace/other"])).toBe(
        path.resolve("/workspace/repo", ".agentgit", "authority.sock"),
      );
    });
  });

  it("ignores blank workspace roots", () => {
    return loadModule().then(({ resolveAuthoritySocketPath }) => {
      expect(resolveAuthoritySocketPath(["", "   ", "/workspace/repo"])).toBe(
        path.resolve("/workspace/repo", ".agentgit", "authority.sock"),
      );
    });
  });

  it("returns undefined when no workspace roots are available", () => {
    return loadModule().then(({ resolveAuthoritySocketPath }) => {
      expect(resolveAuthoritySocketPath([])).toBeUndefined();
    });
  });
});

describe("resolveAuthorityWorkspaceRoots", () => {
  it("uses repository runtime roots when available", async () => {
    const { collectWorkspaceRepositoryRuntimeRecords } = await import("@/lib/backend/workspace/repository-inventory");
    const { resolveWorkspaceRoots } = await import("@/lib/backend/workspace/roots");
    const { resolveAuthorityWorkspaceRoots } = await loadModule();

    vi.mocked(collectWorkspaceRepositoryRuntimeRecords).mockReturnValue([
      {
        metadata: { root: "/workspace/repo-a" },
      },
      {
        metadata: { root: "/workspace/repo-b" },
      },
      {
        metadata: { root: "/workspace/repo-a" },
      },
    ] as never);
    vi.mocked(resolveWorkspaceRoots).mockReturnValue(["/workspace/fallback"]);

    expect(resolveAuthorityWorkspaceRoots("ws_123")).toEqual(["/workspace/repo-a", "/workspace/repo-b"]);
  });

  it("falls back to configured workspace roots before repository inventory exists", async () => {
    const { collectWorkspaceRepositoryRuntimeRecords } = await import("@/lib/backend/workspace/repository-inventory");
    const { resolveWorkspaceRoots } = await import("@/lib/backend/workspace/roots");
    const { resolveAuthorityWorkspaceRoots } = await loadModule();

    vi.mocked(collectWorkspaceRepositoryRuntimeRecords).mockReturnValue([] as never);
    vi.mocked(resolveWorkspaceRoots).mockReturnValue(["/workspace/fallback"]);

    expect(resolveAuthorityWorkspaceRoots("ws_123")).toEqual(["/workspace/fallback"]);
  });
});
