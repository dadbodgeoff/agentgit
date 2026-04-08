import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { vi } from "vitest";

vi.mock("server-only", () => ({}));

import { saveWorkspaceConnectionState } from "@/lib/backend/workspace/cloud-state";
import {
  notifyWorkspaceApprovalRequested,
  resolveWorkspaceIntegrations,
  saveWorkspaceIntegrations,
  sendWorkspaceIntegrationTest,
} from "@/lib/backend/workspace/workspace-integrations";
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

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createRepo(remoteUrl: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-integrations-"));

  runGit(["init", "-b", "main"], repoRoot);
  runGit(["config", "user.name", "AgentGit Test"], repoRoot);
  runGit(["config", "user.email", "tests@agentgit.dev"], repoRoot);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "# Integrations repo\n", "utf8");
  runGit(["add", "README.md"], repoRoot);
  runGit(["commit", "-m", "Initial commit"], repoRoot);
  runGit(["remote", "add", "origin", remoteUrl], repoRoot);

  return repoRoot;
}

describe("workspace integrations backend", () => {
  const originalAgentGitRoot = process.env.AGENTGIT_ROOT;
  const originalEmailFrom = process.env.AGENTGIT_EMAIL_FROM;
  const originalResendApiKey = process.env.RESEND_API_KEY;
  const originalSlackWebhookUrl = process.env.AGENTGIT_SLACK_WEBHOOK_URL;
  const originalWorkspaceRoots = process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS;
  const originalFetch = globalThis.fetch;
  const tempDirs: string[] = [];

  afterEach(() => {
    if (originalAgentGitRoot === undefined) {
      delete process.env.AGENTGIT_ROOT;
    } else {
      process.env.AGENTGIT_ROOT = originalAgentGitRoot;
    }

    if (originalWorkspaceRoots === undefined) {
      delete process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS;
    } else {
      process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS = originalWorkspaceRoots;
    }

    if (originalEmailFrom === undefined) {
      delete process.env.AGENTGIT_EMAIL_FROM;
    } else {
      process.env.AGENTGIT_EMAIL_FROM = originalEmailFrom;
    }

    if (originalResendApiKey === undefined) {
      delete process.env.RESEND_API_KEY;
    } else {
      process.env.RESEND_API_KEY = originalResendApiKey;
    }

    if (originalSlackWebhookUrl === undefined) {
      delete process.env.AGENTGIT_SLACK_WEBHOOK_URL;
    } else {
      process.env.AGENTGIT_SLACK_WEBHOOK_URL = originalSlackWebhookUrl;
    }

    globalThis.fetch = originalFetch;

    for (const tempDir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("derives a default integration snapshot from the active workspace and repositories", async () => {
    const repoRoot = createRepo("git@github.com:acme/platform-ui.git");
    tempDirs.push(repoRoot);
    process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS = repoRoot;
    process.env.AGENTGIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-state-"));
    tempDirs.push(process.env.AGENTGIT_ROOT);

    const snapshot = await resolveWorkspaceIntegrations(buildWorkspaceSession());

    expect(snapshot.githubOrgName).toBe("acme-platform");
    expect(snapshot.githubAppInstalled).toBe(false);
    expect(snapshot.webhookStatus).toBe("warning");
  });

  it("persists integration settings and supports test delivery on enabled channels", async () => {
    const repoRoot = createRepo("git@github.com:acme/platform-ui.git");
    tempDirs.push(repoRoot);
    process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS = repoRoot;
    process.env.AGENTGIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-state-"));
    tempDirs.push(process.env.AGENTGIT_ROOT);

    await saveWorkspaceConnectionState({
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
    process.env.AGENTGIT_SLACK_WEBHOOK_URL = "https://hooks.slack.test/services/T000/B000/abc";
    process.env.RESEND_API_KEY = "re_test";
    process.env.AGENTGIT_EMAIL_FROM = "AgentGit <noreply@agentgit.dev>";

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "https://hooks.slack.test/services/T000/B000/abc") {
        return new Response("ok", { status: 200 });
      }

      if (String(input) === "https://api.resend.com/emails") {
        return new Response(JSON.stringify({ id: "email_01" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unexpected fetch target: ${String(input)}`);
    }) as typeof fetch;

    const saveResult = await saveWorkspaceIntegrations(buildWorkspaceSession(), {
      slackConnected: true,
      slackWebhookUrl: "",
      slackWorkspaceName: "Acme Engineering",
      slackChannelName: "#ship-room",
      slackDeliveryMode: "all",
      emailNotificationsEnabled: true,
      digestCadence: "realtime",
      notificationEvents: ["approval_requested", "run_failed"],
    });
    const testResult = await sendWorkspaceIntegrationTest(buildWorkspaceSession(), "slack");
    const emailTest = await sendWorkspaceIntegrationTest(buildWorkspaceSession(), "email");

    expect(saveResult.integrations.slackChannelName).toBe("#ship-room");
    expect(saveResult.integrations.slackWebhookConfigured).toBe(true);
    expect(testResult.message).toContain("#ship-room");
    expect(emailTest.message).toContain("active workspace members");
  });

  it("delivers approval-requested notifications through the configured channels", async () => {
    const repoRoot = createRepo("git@github.com:acme/platform-ui.git");
    tempDirs.push(repoRoot);
    process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS = repoRoot;
    process.env.AGENTGIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-state-"));
    tempDirs.push(process.env.AGENTGIT_ROOT);
    process.env.AGENTGIT_SLACK_WEBHOOK_URL = "https://hooks.slack.test/services/T000/B000/abc";
    process.env.RESEND_API_KEY = "re_test";
    process.env.AGENTGIT_EMAIL_FROM = "AgentGit <noreply@agentgit.dev>";

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "https://hooks.slack.test/services/T000/B000/abc") {
        return new Response("ok", { status: 200 });
      }

      if (String(input) === "https://api.resend.com/emails") {
        return new Response(JSON.stringify({ id: "email_02" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unexpected fetch target: ${String(input)}`);
    }) as typeof fetch;

    await saveWorkspaceConnectionState({
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

    await saveWorkspaceIntegrations(buildWorkspaceSession(), {
      slackConnected: true,
      slackWebhookUrl: "",
      slackWorkspaceName: "Acme Engineering",
      slackChannelName: "#ship-room",
      slackDeliveryMode: "approvals_only",
      emailNotificationsEnabled: true,
      digestCadence: "daily",
      notificationEvents: ["approval_requested"],
    });

    await notifyWorkspaceApprovalRequested({
      workspaceId: "ws_acme_01",
      workspaceSlug: "acme-platform",
      repositoryOwner: "acme",
      repositoryName: "platform-ui",
      approval: {
        approval_id: "appr_01",
        run_id: "run_01",
        workflow_name: "Release train",
        action_id: "act_01",
        action_summary: "Deploy production release",
        action_domain: "deploy",
        side_effect_level: "mutating",
        status: "pending",
        requested_at: "2026-04-07T19:00:00Z",
        resolved_at: null,
        resolution_note: null,
        decision_requested: "approve_or_deny",
        snapshot_required: true,
        reason_summary: "Production deploy requires a reviewer.",
        primary_reason: {
          code: "deploy.review.required",
          message: "Production deploy requires a reviewer.",
        },
        target_locator: "deploy://prod",
        target_label: "Production",
      },
    });

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});
