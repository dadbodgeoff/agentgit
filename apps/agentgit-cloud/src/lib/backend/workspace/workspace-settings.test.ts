import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { vi } from "vitest";

vi.mock("server-only", () => ({}));

import { saveWorkspaceConnectionState, getWorkspaceConnectionState } from "@/lib/backend/workspace/cloud-state";
import { resolveWorkspaceSettings, saveWorkspaceSettings } from "@/lib/backend/workspace/workspace-settings";
import type { WorkspaceSession } from "@/schemas/cloud";

function buildWorkspaceSession(): WorkspaceSession {
  return {
    user: {
      id: "user_01",
      name: "Jordan Smith",
      email: "jordan@acme.dev",
    },
    activeWorkspace: {
      id: "ws_acme_01",
      name: "Acme platform",
      slug: "acme-platform",
      role: "admin",
    },
  };
}

describe("workspace settings backend", () => {
  const originalAgentGitRoot = process.env.AGENTGIT_ROOT;
  const originalFetch = globalThis.fetch;
  const tempDirs: string[] = [];

  afterEach(() => {
    if (originalAgentGitRoot === undefined) {
      delete process.env.AGENTGIT_ROOT;
    } else {
      process.env.AGENTGIT_ROOT = originalAgentGitRoot;
    }

    for (const tempDir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    globalThis.fetch = originalFetch;
  });

  it("derives initial settings from the persisted onboarding workspace state", async () => {
    process.env.AGENTGIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-state-"));
    tempDirs.push(process.env.AGENTGIT_ROOT);

    await saveWorkspaceConnectionState({
      workspaceId: "ws_acme_01",
      workspaceName: "Launch workspace",
      workspaceSlug: "launch-workspace",
      repositoryIds: ["repo_platform"],
      members: [{ name: "Jordan Smith", email: "jordan@acme.dev", role: "admin" }],
      invites: [],
      defaultNotificationChannel: "email",
      policyPack: "guarded",
      launchedAt: "2026-04-07T15:04:00Z",
    });

    const settings = await resolveWorkspaceSettings(buildWorkspaceSession());

    expect(settings).toMatchObject({
      workspaceName: "Launch workspace",
      workspaceSlug: "launch-workspace",
      defaultNotificationChannel: "email",
      approvalTtlMinutes: 30,
      requireRejectComment: true,
      enterpriseSso: expect.objectContaining({
        enabled: false,
        clientSecretConfigured: false,
      }),
    });
  });

  it("persists settings and syncs overlapping workspace identity fields", async () => {
    process.env.AGENTGIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-state-"));
    tempDirs.push(process.env.AGENTGIT_ROOT);

    await saveWorkspaceConnectionState({
      workspaceId: "ws_acme_01",
      workspaceName: "Acme platform",
      workspaceSlug: "acme-platform",
      repositoryIds: ["repo_platform"],
      members: [{ name: "Jordan Smith", email: "jordan@acme.dev", role: "admin" }],
      invites: [],
      defaultNotificationChannel: "slack",
      policyPack: "guarded",
      launchedAt: "2026-04-07T15:04:00Z",
    });

    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            issuer: "https://acme.okta.com/oauth2/default",
            authorization_endpoint: "https://acme.okta.com/oauth2/default/v1/authorize",
            token_endpoint: "https://acme.okta.com/oauth2/default/v1/token",
            jwks_uri: "https://acme.okta.com/oauth2/default/v1/keys",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    ) as typeof fetch;

    const response = await saveWorkspaceSettings(buildWorkspaceSession(), {
      workspaceName: "Platform control",
      workspaceSlug: "platform-control",
      defaultNotificationChannel: "in_app",
      approvalTtlMinutes: 45,
      requireRejectComment: false,
      freezeDeploysOutsideBusinessHours: true,
      enterpriseSso: {
        enabled: true,
        providerType: "oidc",
        providerLabel: "Acme Okta",
        issuerUrl: "https://acme.okta.com/oauth2/default",
        clientId: "agentgit-cloud",
        clientSecret: "super-secret",
        emailDomains: ["acme.dev"],
        autoProvisionMembers: true,
        defaultRole: "member",
      },
    });

    const updatedWorkspace = await getWorkspaceConnectionState("ws_acme_01");
    const resolvedSettings = await resolveWorkspaceSettings(buildWorkspaceSession());

    expect(response.settings.workspaceName).toBe("Platform control");
    expect(updatedWorkspace).toMatchObject({
      workspaceName: "Platform control",
      workspaceSlug: "platform-control",
      defaultNotificationChannel: "in_app",
    });
    expect(resolvedSettings).toMatchObject({
      workspaceName: "Platform control",
      workspaceSlug: "platform-control",
      approvalTtlMinutes: 45,
      freezeDeploysOutsideBusinessHours: true,
      enterpriseSso: expect.objectContaining({
        enabled: true,
        providerLabel: "Acme Okta",
        clientSecretConfigured: true,
      }),
    });
  });

  it("fails closed when enterprise issuer discovery is invalid", async () => {
    process.env.AGENTGIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-state-"));
    tempDirs.push(process.env.AGENTGIT_ROOT);

    await saveWorkspaceConnectionState({
      workspaceId: "ws_acme_01",
      workspaceName: "Acme platform",
      workspaceSlug: "acme-platform",
      repositoryIds: ["repo_platform"],
      members: [{ name: "Jordan Smith", email: "jordan@acme.dev", role: "admin" }],
      invites: [],
      defaultNotificationChannel: "slack",
      policyPack: "guarded",
      launchedAt: "2026-04-07T15:04:00Z",
    });

    globalThis.fetch = vi.fn(async () => new Response("missing", { status: 404 })) as typeof fetch;

    await expect(
      saveWorkspaceSettings(buildWorkspaceSession(), {
        workspaceName: "Platform control",
        workspaceSlug: "platform-control",
        defaultNotificationChannel: "in_app",
        approvalTtlMinutes: 45,
        requireRejectComment: false,
        freezeDeploysOutsideBusinessHours: true,
        enterpriseSso: {
          enabled: true,
          providerType: "oidc",
          providerLabel: "Acme Okta",
          issuerUrl: "https://acme.okta.com/oauth2/default",
          clientId: "agentgit-cloud",
          clientSecret: "super-secret",
          emailDomains: ["acme.dev"],
          autoProvisionMembers: true,
          defaultRole: "member",
        },
      }),
    ).rejects.toThrow("Could not load OIDC discovery metadata");
  });

  it("applies a bounded timeout to enterprise issuer discovery", async () => {
    process.env.AGENTGIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-state-"));
    tempDirs.push(process.env.AGENTGIT_ROOT);

    await saveWorkspaceConnectionState({
      workspaceId: "ws_acme_01",
      workspaceName: "Acme platform",
      workspaceSlug: "acme-platform",
      repositoryIds: ["repo_platform"],
      members: [{ name: "Jordan Smith", email: "jordan@acme.dev", role: "admin" }],
      invites: [],
      defaultNotificationChannel: "slack",
      policyPack: "guarded",
      launchedAt: "2026-04-07T15:04:00Z",
    });

    globalThis.fetch = vi.fn(async () => new Response("missing", { status: 404 })) as typeof fetch;

    await expect(
      saveWorkspaceSettings(buildWorkspaceSession(), {
        workspaceName: "Platform control",
        workspaceSlug: "platform-control",
        defaultNotificationChannel: "in_app",
        approvalTtlMinutes: 45,
        requireRejectComment: false,
        freezeDeploysOutsideBusinessHours: true,
        enterpriseSso: {
          enabled: true,
          providerType: "oidc",
          providerLabel: "Acme Okta",
          issuerUrl: "https://acme.okta.com/oauth2/default",
          clientId: "agentgit-cloud",
          clientSecret: "super-secret",
          emailDomains: ["acme.dev"],
          autoProvisionMembers: true,
          defaultRole: "member",
        },
      }),
    ).rejects.toThrow("Could not load OIDC discovery metadata");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://acme.okta.com/oauth2/default/.well-known/openid-configuration",
      expect.objectContaining({
        cache: "no-store",
        signal: expect.any(AbortSignal),
      }),
    );
  });
});
