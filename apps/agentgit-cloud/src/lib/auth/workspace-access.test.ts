import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { saveWorkspaceConnectionState } from "@/lib/backend/workspace/cloud-state";
import { toWorkspaceSession } from "@/lib/auth/session-mapper";
import { resolveWorkspaceAccessForIdentity } from "@/lib/auth/workspace-access";

describe("workspace access resolution", () => {
  const originalEnv = {
    AGENTGIT_ROOT: process.env.AGENTGIT_ROOT,
    AUTH_BOOTSTRAP_GITHUB_LOGIN: process.env.AUTH_BOOTSTRAP_GITHUB_LOGIN,
    AUTH_BOOTSTRAP_USER_EMAIL: process.env.AUTH_BOOTSTRAP_USER_EMAIL,
    AUTH_BOOTSTRAP_WORKSPACE_ROLE: process.env.AUTH_BOOTSTRAP_WORKSPACE_ROLE,
    AUTH_WORKSPACE_ID: process.env.AUTH_WORKSPACE_ID,
    AUTH_WORKSPACE_NAME: process.env.AUTH_WORKSPACE_NAME,
    AUTH_WORKSPACE_SLUG: process.env.AUTH_WORKSPACE_SLUG,
  };
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();

    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    for (const tempDir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves persisted workspace membership by email", () => {
    process.env.AGENTGIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-auth-"));
    tempDirs.push(process.env.AGENTGIT_ROOT);

    saveWorkspaceConnectionState({
      workspaceId: "ws_acme_01",
      workspaceName: "Acme platform",
      workspaceSlug: "acme-platform",
      repositoryIds: [],
      members: [{ name: "Jordan Smith", email: "jordan@acme.dev", role: "admin" }],
      invites: [],
      defaultNotificationChannel: "slack",
      policyPack: "guarded",
      launchedAt: "2026-04-07T15:04:00Z",
    });

    const access = resolveWorkspaceAccessForIdentity({ email: "jordan@acme.dev", login: "jordansmith" });

    expect(access).toMatchObject({
      role: "admin",
      source: "member",
      activeWorkspace: {
        id: "ws_acme_01",
        slug: "acme-platform",
      },
    });
  });

  it("does not grant access from shared fallback workspace settings alone", () => {
    process.env.AUTH_WORKSPACE_ID = "ws_shared";
    process.env.AUTH_WORKSPACE_NAME = "Shared";
    process.env.AUTH_WORKSPACE_SLUG = "shared";

    const access = resolveWorkspaceAccessForIdentity({ email: "unknown@agentgit.dev", login: "unknown" });

    expect(access).toBeNull();
  });

  it("allows an explicitly configured bootstrap identity", () => {
    process.env.AUTH_BOOTSTRAP_USER_EMAIL = "owner@acme.dev";
    process.env.AUTH_BOOTSTRAP_WORKSPACE_ROLE = "owner";
    process.env.AUTH_WORKSPACE_ID = "ws_bootstrap_01";
    process.env.AUTH_WORKSPACE_NAME = "Bootstrap workspace";
    process.env.AUTH_WORKSPACE_SLUG = "bootstrap-workspace";

    const access = resolveWorkspaceAccessForIdentity({ email: "owner@acme.dev", login: "acme-owner" });

    expect(access).toMatchObject({
      role: "owner",
      source: "bootstrap",
      activeWorkspace: {
        id: "ws_bootstrap_01",
        slug: "bootstrap-workspace",
      },
    });
  });

  it("fails closed when the same identity belongs to multiple workspaces", () => {
    process.env.AGENTGIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-auth-"));
    tempDirs.push(process.env.AGENTGIT_ROOT);

    saveWorkspaceConnectionState({
      workspaceId: "ws_acme_01",
      workspaceName: "Acme platform",
      workspaceSlug: "acme-platform",
      repositoryIds: [],
      members: [{ name: "Jordan Smith", email: "jordan@acme.dev", role: "admin" }],
      invites: [],
      defaultNotificationChannel: "slack",
      policyPack: "guarded",
      launchedAt: "2026-04-07T15:04:00Z",
    });
    saveWorkspaceConnectionState({
      workspaceId: "ws_beta_01",
      workspaceName: "Beta platform",
      workspaceSlug: "beta-platform",
      repositoryIds: [],
      members: [{ name: "Jordan Smith", email: "jordan@acme.dev", role: "member" }],
      invites: [],
      defaultNotificationChannel: "email",
      policyPack: "balanced",
      launchedAt: "2026-04-07T16:04:00Z",
    });

    const access = resolveWorkspaceAccessForIdentity({ email: "jordan@acme.dev", login: "jordansmith" });

    expect(access).toBeNull();
  });

  it("refuses to build a workspace session when role or workspace are missing", () => {
    const workspaceSession = toWorkspaceSession({
      user: {
        email: "jordan@acme.dev",
        id: "user_01",
        name: "Jordan Smith",
      },
    } as never);

    expect(workspaceSession).toBeNull();
  });
});
