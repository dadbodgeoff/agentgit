import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withControlPlaneState } from "@/lib/backend/control-plane/state";
import { saveStoredWorkspaceSettings } from "@/lib/backend/workspace/cloud-state";
import {
  listWorkspaceApprovalProjections,
  listWorkspaceApprovalQueue,
} from "@/lib/backend/workspace/workspace-approvals";

function seedApprovalRequestedEvent(requestedAt = new Date().toISOString()) {
  const ingestedAt = new Date(new Date(requestedAt).getTime() + 5_000).toISOString();
  withControlPlaneState((store) => {
    store.appendEvent({
      event: {
        schemaVersion: "cloud-sync.v1",
        eventId: "evt_approval_requested_01",
        connectorId: "conn_01",
        workspaceId: "ws_acme_01",
        repository: {
          owner: "acme",
          name: "platform-ui",
        },
        sequence: 1,
        occurredAt: requestedAt,
        type: "approval.requested",
        payload: {
          approval_id: "appr_01",
          run_id: "run_01",
          workflow_name: "Ship fix",
          action_id: "act_01",
          action_summary: "Deploy preview environment",
          action_domain: "deploy",
          side_effect_level: "mutating",
          status: "pending",
          requested_at: requestedAt,
          resolved_at: null,
          resolution_note: null,
          decision_requested: "approve_or_deny",
          snapshot_required: true,
          reason_summary: "Production-like deploy needs review.",
          primary_reason: {
            code: "deploy.review.required",
            message: "Production-like deploy needs review.",
          },
          target_locator: "deploy://preview",
          target_label: "Preview environment",
        },
      },
      ingestedAt,
    });
  });
}

describe("workspace approval projection", () => {
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

  it("builds the approval queue from synced connector events", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-approvals-"));
    tempDirs.push(tempDir);
    process.env.AGENTGIT_ROOT = tempDir;

    seedApprovalRequestedEvent();

    const queue = await listWorkspaceApprovalQueue("ws_acme_01");

    expect(queue.items).toMatchObject([
      {
        id: "appr_01",
        repositoryOwner: "acme",
        repositoryName: "platform-ui",
        status: "pending",
        workflowName: "Ship fix",
        snapshotRequired: true,
      },
    ]);
  });

  it("overlays queued approval-resolution commands so the UI reflects the in-flight decision", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-approvals-"));
    tempDirs.push(tempDir);
    process.env.AGENTGIT_ROOT = tempDir;

    seedApprovalRequestedEvent();
    withControlPlaneState((store) => {
      store.putCommand({
        command: {
          schemaVersion: "cloud-sync.v1",
          commandId: "cmd_approval_01",
          connectorId: "conn_01",
          workspaceId: "ws_acme_01",
          repository: {
            owner: "acme",
            name: "platform-ui",
          },
          issuedAt: "2026-04-07T19:01:00Z",
          expiresAt: "2026-04-08T19:01:00Z",
          type: "resolve_approval",
          payload: {
            approvalId: "appr_01",
            resolution: "approved",
            note: "Looks good.",
          },
        },
        status: "acked",
        updatedAt: "2026-04-07T19:01:10Z",
        acknowledgedAt: "2026-04-07T19:01:10Z",
        leaseExpiresAt: "2026-04-07T19:06:10Z",
        attemptCount: 1,
        nextAttemptAt: null,
        lastMessage: "Connector received command.",
        result: null,
      });
    });

    const approvals = await listWorkspaceApprovalProjections("ws_acme_01");

    expect(approvals[0]).toMatchObject({
      id: "appr_01",
      status: "approved",
      commandId: "cmd_approval_01",
      decisionCommandStatus: "acked",
      resolutionNote: "Looks good.",
      repositoryOwner: "acme",
      repositoryName: "platform-ui",
    });
  });

  it("marks timed-out approvals expired and surfaces stale connector recovery context", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-approvals-"));
    tempDirs.push(tempDir);
    process.env.AGENTGIT_ROOT = tempDir;

    await saveStoredWorkspaceSettings("ws_acme_01", {
      workspaceName: "Acme",
      workspaceSlug: "acme",
      defaultNotificationChannel: "slack",
      approvalTtlMinutes: 15,
      requireRejectComment: true,
      freezeDeploysOutsideBusinessHours: false,
      enterpriseSso: {
        enabled: false,
        providerType: "oidc",
        providerLabel: "Enterprise SSO",
        issuerUrl: "https://idp.example.com/realms/agentgit",
        clientId: "agentgit-cloud",
        emailDomains: [],
        autoProvisionMembers: true,
        defaultRole: "member",
        clientSecretConfigured: false,
      },
    });

    seedApprovalRequestedEvent("2026-04-07T19:00:00Z");
    withControlPlaneState((store) => {
      store.putConnector({
        id: "conn_01",
        workspaceId: "ws_acme_01",
        workspaceSlug: "acme",
        connectorName: "primary",
        machineName: "geoffrey-mbp",
        connectorVersion: "0.1.0",
        platform: {
          os: "darwin",
          arch: "arm64",
          hostname: "geoffrey-mbp",
        },
        capabilities: ["approval_resolution"],
        repository: {
          provider: "github",
          repo: {
            owner: "acme",
            name: "platform-ui",
          },
          remoteUrl: "git@github.com:acme/platform-ui.git",
          defaultBranch: "main",
          currentBranch: "main",
          headSha: "abcdef1234567",
          isDirty: false,
          aheadBy: 0,
          behindBy: 0,
          workspaceRoot: "/tmp/workspaces/platform-ui",
          lastFetchedAt: null,
        },
        status: "active",
        registeredAt: "2026-04-07T18:00:00Z",
        lastSeenAt: "2026-04-07T18:00:00Z",
      });
      store.putConnectorToken({
        tokenHash: "token_conn_01",
        connectorId: "conn_01",
        workspaceId: "ws_acme_01",
        issuedAt: "2026-04-07T18:00:00Z",
        expiresAt: "2026-05-07T18:00:00Z",
        revokedAt: null,
      });
      store.putCommand({
        command: {
          schemaVersion: "cloud-sync.v1",
          commandId: "cmd_approval_01",
          connectorId: "conn_01",
          workspaceId: "ws_acme_01",
          repository: {
            owner: "acme",
            name: "platform-ui",
          },
          issuedAt: "2026-04-07T19:05:00Z",
          expiresAt: "2026-04-08T19:05:00Z",
          type: "resolve_approval",
          payload: {
            approvalId: "appr_01",
            resolution: "approved",
            note: "Looks good.",
          },
        },
        status: "failed",
        updatedAt: "2026-04-07T19:06:00Z",
        acknowledgedAt: null,
        leaseExpiresAt: null,
        attemptCount: 1,
        nextAttemptAt: null,
        lastMessage: "Connector lost contact before delivery.",
        result: null,
      });
    });

    const approvals = await listWorkspaceApprovalProjections("ws_acme_01");

    expect(approvals[0]).toMatchObject({
      id: "appr_01",
      status: "expired",
      connectorStatus: "stale",
      decisionCommandStatus: "failed",
      decisionCommandMessage: "Connector lost contact before delivery.",
    });
    expect(approvals[0]?.connectorStatusReason).toContain("No heartbeat seen");
    expect(approvals[0]?.expiresAt).toBeDefined();
  });
});
