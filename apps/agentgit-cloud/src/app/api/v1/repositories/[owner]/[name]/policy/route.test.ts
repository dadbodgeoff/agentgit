import { beforeEach, describe, expect, it, vi } from "vitest";

const requireApiRole = vi.fn();
const resolveRepositoryPolicy = vi.fn();
const saveRepositoryPolicy = vi.fn();
const validateRepositoryPolicyDocument = vi.fn();

vi.mock("server-only", () => ({}));

vi.mock("@/lib/auth/api-session", () => ({
  requireApiRole,
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
  resolveRepositoryPolicy,
  saveRepositoryPolicy,
  validateRepositoryPolicyDocument,
}));

describe("repository policy route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a repository policy snapshot for an authorized admin", async () => {
    requireApiRole.mockResolvedValue({
      denied: null,
      workspaceSession: {
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
        body: JSON.stringify({ document: "{\"policy_version\":1}" }),
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
    expect(saveRepositoryPolicy).toHaveBeenCalledWith(
      "acme",
      "platform-ui",
      expect.any(String),
      "ws_acme_01",
    );
    expect(body.message).toBe("Policy saved.");
  });
});
