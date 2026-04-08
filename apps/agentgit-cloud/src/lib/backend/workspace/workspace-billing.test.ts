import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { vi } from "vitest";

vi.mock("server-only", () => ({}));

import { saveStoredWorkspaceBilling, saveWorkspaceConnectionState } from "@/lib/backend/workspace/cloud-state";
import { withControlPlaneState } from "@/lib/backend/control-plane/state";
import {
  resolveWorkspaceBilling,
  saveWorkspaceBilling,
  WorkspaceBillingLimitError,
} from "@/lib/backend/workspace/workspace-billing";
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
      role: "owner",
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
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-billing-"));

  runGit(["init", "-b", "main"], repoRoot);
  runGit(["config", "user.name", "AgentGit Test"], repoRoot);
  runGit(["config", "user.email", "tests@agentgit.dev"], repoRoot);
  fs.writeFileSync(path.join(repoRoot, "README.md"), "# Billing repo\n", "utf8");
  runGit(["add", "README.md"], repoRoot);
  runGit(["commit", "-m", "Initial commit"], repoRoot);
  runGit(["remote", "add", "origin", remoteUrl], repoRoot);

  return repoRoot;
}

describe("workspace billing backend", () => {
  const originalAgentGitRoot = process.env.AGENTGIT_ROOT;
  const originalWorkspaceRoots = process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS;
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

    for (const tempDir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("derives workspace usage metrics from connected repositories and invites", async () => {
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
      members: [{ name: "Jordan Smith", email: "jordan@acme.dev", role: "owner" }],
      invites: [
        { name: "Riley", email: "riley@acme.dev", role: "member" },
        { name: "Ari", email: "ari@acme.dev", role: "admin" },
      ],
      defaultNotificationChannel: "slack",
      policyPack: "guarded",
      launchedAt: "2026-04-07T15:04:00Z",
    });

    const billing = await resolveWorkspaceBilling(buildWorkspaceSession());

    expect(billing.repositoriesConnected).toBe(0);
    expect(billing.seatsUsed).toBe(3);
    expect(billing.approvalsUsed).toBe(0);
  });

  it("counts recent approval requests toward the hosted beta approval budget", async () => {
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
      members: [{ name: "Jordan Smith", email: "jordan@acme.dev", role: "owner" }],
      invites: [],
      defaultNotificationChannel: "slack",
      policyPack: "guarded",
      launchedAt: "2026-04-07T15:04:00Z",
    });

    withControlPlaneState((store) => {
      store.appendEvent({
        ingestedAt: "2026-04-07T19:00:00Z",
        event: {
          schemaVersion: "cloud-sync.v1",
          eventId: "evt_approval_01",
          connectorId: "conn_01",
          workspaceId: "ws_acme_01",
          repository: { owner: "acme", name: "platform-ui" },
          sequence: 1,
          occurredAt: "2026-04-07T19:00:00Z",
          type: "approval.requested",
          payload: {
            approval: {
              approval_id: "appr_01",
              run_id: "run_01",
              workflow_name: "Release train",
              action_id: "act_01",
              action_summary: "Deploy",
              action_domain: "deploy",
              side_effect_level: "mutating",
              status: "pending",
              requested_at: "2026-04-07T19:00:00Z",
              resolved_at: null,
              resolution_note: null,
              decision_requested: "approve_or_deny",
              snapshot_required: false,
              target_locator: "deploy://prod",
              target_label: "prod",
              reason_summary: "Ship it",
            },
          },
        },
      });
    });

    const billing = await resolveWorkspaceBilling(buildWorkspaceSession());

    expect(billing.approvalsUsed).toBe(1);
  });

  it("persists billing updates and keeps derived usage fresh", async () => {
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
      members: [{ name: "Jordan Smith", email: "jordan@acme.dev", role: "owner" }],
      invites: [{ name: "Riley", email: "riley@acme.dev", role: "member" }],
      defaultNotificationChannel: "slack",
      policyPack: "guarded",
      launchedAt: "2026-04-07T15:04:00Z",
    });

    const result = await saveWorkspaceBilling(buildWorkspaceSession(), {
      planTier: "enterprise",
      billingCycle: "monthly",
      billingEmail: "finance@acme.dev",
      invoiceEmail: "ap@acme.dev",
      taxId: "US-ACME-99",
    });

    expect(result.billing.planTier).toBe("enterprise");
    expect(result.billing.monthlyEstimateUsd).toBe(4990);
    expect(result.billing.seatsIncluded).toBe(50);
    expect(result.billing.seatsUsed).toBe(2);
    expect(result.billing.billingProvider).toBe("beta_gate");
    expect(result.billing.limitBreaches).toEqual([]);
    expect(result.billing.invoices).toEqual([]);
  });

  it("rejects plan saves that would leave the workspace over the selected beta limits", async () => {
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
      members: [{ name: "Jordan Smith", email: "jordan@acme.dev", role: "owner" }],
      invites: [
        { name: "Riley", email: "riley@acme.dev", role: "member" },
        { name: "Ari", email: "ari@acme.dev", role: "admin" },
        { name: "Sam", email: "sam@acme.dev", role: "member" },
        { name: "Noa", email: "noa@acme.dev", role: "member" },
        { name: "Mika", email: "mika@acme.dev", role: "member" },
      ],
      defaultNotificationChannel: "slack",
      policyPack: "guarded",
      launchedAt: "2026-04-07T15:04:00Z",
    });

    await expect(
      saveWorkspaceBilling(buildWorkspaceSession(), {
        planTier: "starter",
        billingCycle: "monthly",
        billingEmail: "finance@acme.dev",
        invoiceEmail: "ap@acme.dev",
        taxId: "",
      }),
    ).rejects.toBeInstanceOf(WorkspaceBillingLimitError);
  });

  it("preserves live Stripe billing metadata when owners update billing contacts", async () => {
    const repoRoot = createRepo("git@github.com:acme/platform-ui.git");
    tempDirs.push(repoRoot);
    process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS = repoRoot;
    process.env.AGENTGIT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-billing-"));
    tempDirs.push(process.env.AGENTGIT_ROOT);

    await saveWorkspaceConnectionState({
      workspaceId: "ws_acme_01",
      workspaceName: "Acme platform",
      workspaceSlug: "acme-platform",
      repositoryIds: [],
      members: [{ name: "Jordan Smith", email: "jordan@acme.dev", role: "owner" }],
      invites: [],
      defaultNotificationChannel: "slack",
      policyPack: "guarded",
      launchedAt: "2026-04-07T15:04:00Z",
    });

    await saveStoredWorkspaceBilling("ws_acme_01", {
      workspaceId: "ws_acme_01",
      workspaceName: "Acme platform",
      billingProvider: "stripe",
      billingAccessStatus: "active",
      limitBreaches: [],
      planTier: "team",
      billingCycle: "yearly",
      billingEmail: "finance@acme.dev",
      invoiceEmail: "ap@acme.dev",
      taxId: undefined,
      seatsIncluded: 15,
      seatsUsed: 1,
      repositoriesIncluded: 40,
      repositoriesConnected: 0,
      approvalsIncluded: 5000,
      approvalsUsed: 0,
      monthlyEstimateUsd: 1267,
      nextInvoiceDate: "2026-05-07T15:04:00Z",
      paymentMethodLabel: "VISA ending 4242",
      paymentMethodStatus: "active",
      invoices: [],
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_123",
    });

    const result = await saveWorkspaceBilling(buildWorkspaceSession(), {
      planTier: "team",
      billingCycle: "yearly",
      billingEmail: "ops-finance@acme.dev",
      invoiceEmail: "procurement@acme.dev",
      taxId: "US-ACME-100",
    });

    expect(result.billing.billingProvider).toBe("stripe");
    expect(result.billing.stripeCustomerId).toBe("cus_123");
    expect(result.billing.stripeSubscriptionId).toBe("sub_123");
    expect(result.billing.paymentMethodLabel).toBe("VISA ending 4242");
    expect(result.billing.billingEmail).toBe("ops-finance@acme.dev");
    expect(result.billing.invoiceEmail).toBe("procurement@acme.dev");
  });
});
