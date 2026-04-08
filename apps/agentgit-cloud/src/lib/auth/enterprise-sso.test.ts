import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  saveStoredWorkspaceSettings,
  saveWorkspaceConnectionState,
  saveWorkspaceSsoSecrets,
} from "@/lib/backend/workspace/cloud-state";
import {
  buildEnterpriseProviderId,
  getEnterpriseSsoProviderFromRequest,
  resolveEnterpriseWorkspaceAccessForIdentity,
} from "@/lib/auth/enterprise-sso";

describe("enterprise sso", () => {
  const originalAgentGitRoot = process.env.AGENTGIT_ROOT;
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
  });

  async function seedWorkspace() {
    process.env.AGENTGIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-enterprise-sso-"));
    tempDirs.push(process.env.AGENTGIT_ROOT);

    await saveWorkspaceConnectionState({
      workspaceId: "ws_acme_01",
      workspaceName: "Acme platform",
      workspaceSlug: "acme-platform",
      repositoryIds: [],
      members: [{ name: "Jordan Smith", email: "jordan@acme.dev", role: "admin" }],
      invites: [{ name: "Avery Chen", email: "avery@acme.dev", role: "member" }],
      defaultNotificationChannel: "slack",
      policyPack: "guarded",
      launchedAt: "2026-04-07T15:04:00Z",
    });

    await saveStoredWorkspaceSettings("ws_acme_01", {
      workspaceName: "Acme platform",
      workspaceSlug: "acme-platform",
      defaultNotificationChannel: "slack",
      approvalTtlMinutes: 30,
      requireRejectComment: true,
      freezeDeploysOutsideBusinessHours: false,
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
    });

    await saveWorkspaceSsoSecrets("ws_acme_01", {
      clientSecret: "super-secret",
    });
  }

  it("builds a dynamic enterprise provider from the workspace slug", async () => {
    await seedWorkspace();

    const provider = await getEnterpriseSsoProviderFromRequest(
      new Request(`http://localhost/api/auth/signin/${buildEnterpriseProviderId("acme-platform")}`),
    );

    expect(provider).toMatchObject({
      workspaceId: "ws_acme_01",
      workspaceSlug: "acme-platform",
      settings: {
        providerLabel: "Acme Okta",
      },
    });
    expect(provider?.provider).toMatchObject({
      id: "enterprise-acme-platform",
      issuer: "https://acme.okta.com/oauth2/default",
      clientId: "agentgit-cloud",
      type: "oidc",
    });
  });

  it("auto-provisions a matching domain into the configured workspace", async () => {
    await seedWorkspace();

    const access = await resolveEnterpriseWorkspaceAccessForIdentity({
      workspaceSlug: "acme-platform",
      email: "new.user@acme.dev",
      name: "New User",
    });

    expect(access).toMatchObject({
      role: "member",
      activeWorkspace: {
        id: "ws_acme_01",
        slug: "acme-platform",
      },
    });
  });

  it("fails closed for users outside the allowed enterprise domains", async () => {
    await seedWorkspace();

    const access = await resolveEnterpriseWorkspaceAccessForIdentity({
      workspaceSlug: "acme-platform",
      email: "outsider@example.com",
      name: "Outside User",
    });

    expect(access).toBeNull();
  });
});
