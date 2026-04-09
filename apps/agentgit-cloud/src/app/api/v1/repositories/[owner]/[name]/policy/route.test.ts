import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiRole = vi.fn();
const hasRepositoryRouteAccess = vi.fn();
const rollbackRepositoryPolicyVersion = vi.fn();
const resolveRepositoryPolicy = vi.fn();
const saveRepositoryPolicy = vi.fn();
const validateRepositoryPolicyDocument = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiRole,
}));

vi.mock("@/lib/backend/workspace/repository-route-access", () => ({
  hasRepositoryRouteAccess,
}));

vi.mock("@/lib/backend/workspace/repository-policy", () => ({
  RepositoryPolicyInputError: class RepositoryPolicyInputError extends Error {
    constructor(
      message: string,
      public readonly issues: string[] = [],
    ) {
      super(message);
    }
  },
  RepositoryPolicyVersionNotFoundError: class RepositoryPolicyVersionNotFoundError extends Error {
    constructor(message = "Repository policy version was not found.") {
      super(message);
    }
  },
  rollbackRepositoryPolicyVersion,
  resolveRepositoryPolicy,
  saveRepositoryPolicy,
  validateRepositoryPolicyDocument,
}));

describe("repository policy route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasRepositoryRouteAccess.mockResolvedValue(true);
  });

  it("returns a repository policy snapshot for an authorized admin", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        user: { id: "usr_01", name: "Jordan Smith", email: "jordan@acme.dev" },
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "admin" },
      },
    });
    resolveRepositoryPolicy.mockResolvedValue({
      repoId: "repo_01",
      owner: "acme",
      name: "platform-ui",
      policyPath: "/tmp/repo/.agentgit/policy.toml",
      authorityReachable: false,
      hasWorkspaceOverride: true,
      effectivePolicy: {
        policy: {
          profile_name: "workspace-override",
          policy_version: "2026-04-07",
          thresholds: { low_confidence: [] },
          rules: [],
        },
        summary: {
          profile_name: "workspace-override",
          policy_versions: ["2026-04-07"],
          compiled_rule_count: 0,
          loaded_sources: [],
          warnings: [],
        },
      },
      workspaceConfig: {
        profile_name: "workspace-override",
        policy_version: "2026-04-07",
        thresholds: { low_confidence: [] },
        rules: [],
      },
      validation: {
        valid: true,
        issues: [],
        compiledProfileName: "workspace-override",
        compiledRuleCount: 0,
      },
      recommendations: [],
      loadedSources: [],
      currentVersionId: "polver_current",
      history: [],
    });

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/v1/repositories/acme/platform-ui/policy"), {
      params: Promise.resolve({ owner: "acme", name: "platform-ui" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.owner).toBe("acme");
    expect(response.headers.get("x-agentgit-request-id")).toBeTruthy();
  });

  it("validates a policy document draft", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        user: { id: "usr_01", name: "Jordan Smith", email: "jordan@acme.dev" },
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "admin" },
      },
    });
    validateRepositoryPolicyDocument.mockReturnValue({
      valid: false,
      issues: ["policy_version: Invalid input"],
      compiledProfileName: null,
      compiledRuleCount: null,
    });

    const { POST } = await import("./route");
    const response = await POST(
      new Request("http://localhost/api/v1/repositories/acme/platform-ui/policy", {
        method: "POST",
        body: JSON.stringify({ document: '{"policy_version":1}' }),
      }),
      {
        params: Promise.resolve({ owner: "acme", name: "platform-ui" }),
      },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.valid).toBe(false);
  });

  it("saves a valid policy payload", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        user: { id: "usr_01", name: "Jordan Smith", email: "jordan@acme.dev" },
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "admin" },
      },
    });
    saveRepositoryPolicy.mockResolvedValue({
      policy: {
        repoId: "repo_01",
        owner: "acme",
        name: "platform-ui",
        policyPath: "/tmp/repo/.agentgit/policy.toml",
        authorityReachable: false,
        hasWorkspaceOverride: true,
        effectivePolicy: {
          policy: {
            profile_name: "workspace-override",
            policy_version: "2026-04-07",
            thresholds: { low_confidence: [] },
            rules: [],
          },
          summary: {
            profile_name: "workspace-override",
            policy_versions: ["2026-04-07"],
            compiled_rule_count: 0,
            loaded_sources: [],
            warnings: [],
          },
        },
        workspaceConfig: {
          profile_name: "workspace-override",
          policy_version: "2026-04-07",
          thresholds: { low_confidence: [] },
          rules: [],
        },
        validation: {
          valid: true,
          issues: [],
          compiledProfileName: "workspace-override",
          compiledRuleCount: 0,
        },
        recommendations: [],
        loadedSources: [],
        currentVersionId: "polver_current",
        history: [],
      },
      savedAt: "2026-04-07T12:00:00Z",
      message: "Policy saved.",
    });

    const { PUT } = await import("./route");
    const response = await PUT(
      new Request("http://localhost/api/v1/repositories/acme/platform-ui/policy", {
        method: "PUT",
        body: JSON.stringify({
          document: JSON.stringify({
            profile_name: "workspace-override",
            policy_version: "2026-04-07",
            thresholds: { low_confidence: [] },
            rules: [],
          }),
        }),
      }),
      {
        params: Promise.resolve({ owner: "acme", name: "platform-ui" }),
      },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(saveRepositoryPolicy).toHaveBeenCalledWith("acme", "platform-ui", expect.any(String), "ws_acme_01", {
      userId: "usr_01",
      name: "Jordan Smith",
      email: "jordan@acme.dev",
    });
    expect(body.message).toBe("Policy saved.");
  });

  it("rolls back to a selected policy version", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        user: { id: "usr_01", name: "Jordan Smith", email: "jordan@acme.dev" },
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "admin" },
      },
    });
    rollbackRepositoryPolicyVersion.mockResolvedValue({
      policy: {
        repoId: "repo_01",
        owner: "acme",
        name: "platform-ui",
        policyPath: "/tmp/repo/.agentgit/policy.toml",
        authorityReachable: false,
        hasWorkspaceOverride: true,
        effectivePolicy: {
          policy: {
            profile_name: "workspace-override",
            policy_version: "2026-04-01",
            thresholds: { low_confidence: [] },
            rules: [],
          },
          summary: {
            profile_name: "workspace-override",
            policy_versions: ["2026-04-01"],
            compiled_rule_count: 0,
            loaded_sources: [],
            warnings: [],
          },
        },
        workspaceConfig: {
          profile_name: "workspace-override",
          policy_version: "2026-04-01",
          thresholds: { low_confidence: [] },
          rules: [],
        },
        validation: {
          valid: true,
          issues: [],
          compiledProfileName: "workspace-override",
          compiledRuleCount: 0,
        },
        recommendations: [],
        loadedSources: [],
        currentVersionId: "polver_rollback",
        history: [],
      },
      savedAt: "2026-04-07T12:05:00Z",
      message: "Policy rolled back.",
    });

    const { PATCH } = await import("./route");
    const response = await PATCH(
      new Request("http://localhost/api/v1/repositories/acme/platform-ui/policy", {
        method: "PATCH",
        body: JSON.stringify({ versionId: "polver_prev" }),
      }),
      {
        params: Promise.resolve({ owner: "acme", name: "platform-ui" }),
      },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(rollbackRepositoryPolicyVersion).toHaveBeenCalledWith("acme", "platform-ui", "polver_prev", "ws_acme_01", {
      userId: "usr_01",
      name: "Jordan Smith",
      email: "jordan@acme.dev",
    });
    expect(body.message).toBe("Policy rolled back.");
  });

  it("fails closed when the repository is outside the active workspace", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
        user: { id: "usr_01", name: "Jordan Smith", email: "jordan@acme.dev" },
        activeWorkspace: { id: "ws_acme_01", name: "Acme", slug: "acme", role: "admin" },
      },
    });
    hasRepositoryRouteAccess.mockResolvedValue(false);

    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/v1/repositories/acme/platform-ui/policy"), {
      params: Promise.resolve({ owner: "acme", name: "platform-ui" }),
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.message).toContain("not found");
    expect(resolveRepositoryPolicy).not.toHaveBeenCalled();
  });
});
