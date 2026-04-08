import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentGitError } from "@agentgit/schemas";

import { ControlPlaneStateStore } from "./index.js";

describe("control plane state store", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("stores connectors and idempotent ingested events", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-control-plane-state-"));
    tempDirs.push(tempDir);
    const store = new ControlPlaneStateStore(path.join(tempDir, "control-plane.db"));

    try {
      store.putConnector({
        id: "conn_01",
        workspaceId: "ws_acme_01",
        workspaceSlug: "acme",
        connectorName: "MacBook connector",
        machineName: "geoffrey-mbp",
        connectorVersion: "0.1.0",
        platform: {
          os: "darwin",
          arch: "arm64",
          hostname: "geoffrey-mbp",
        },
        capabilities: ["repo_state_sync"],
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
          workspaceRoot: "/Users/me/code/platform-ui",
          lastFetchedAt: null,
        },
        status: "active",
        registeredAt: "2026-04-07T18:00:00Z",
        lastSeenAt: "2026-04-07T18:00:00Z",
      });

      store.appendEvent({
        ingestedAt: "2026-04-07T18:01:00Z",
        event: {
          schemaVersion: "cloud-sync.v1",
          eventId: "evt_01",
          connectorId: "conn_01",
          workspaceId: "ws_acme_01",
          repository: {
            owner: "acme",
            name: "platform-ui",
          },
          sequence: 1,
          occurredAt: "2026-04-07T18:01:00Z",
          type: "repo_state.snapshot",
          payload: {
            headSha: "abcdef1234567",
          },
        },
      });

      expect(() =>
        store.appendEvent({
          ingestedAt: "2026-04-07T18:01:01Z",
          event: {
            schemaVersion: "cloud-sync.v1",
            eventId: "evt_01",
            connectorId: "conn_01",
            workspaceId: "ws_acme_01",
            repository: {
              owner: "acme",
              name: "platform-ui",
            },
            sequence: 1,
            occurredAt: "2026-04-07T18:01:00Z",
            type: "repo_state.snapshot",
            payload: {
              headSha: "abcdef1234567",
            },
          },
        }),
      ).toThrowError(
        new AgentGitError("Connector event already exists and cannot be appended twice.", "CONFLICT", {
          event_id: "evt_01",
          connector_id: "conn_01",
        }),
      );

      expect(store.getConnector("conn_01")?.machineName).toBe("geoffrey-mbp");
      expect(store.listEvents("conn_01")).toHaveLength(1);
      expect(store.getHighestEventSequence("conn_01")).toBe(1);
    } finally {
      store.close();
    }
  });

  it("stores bootstrap tokens and updates queued command status", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-control-plane-state-"));
    tempDirs.push(tempDir);
    const store = new ControlPlaneStateStore(path.join(tempDir, "control-plane.db"));

    try {
      store.putConnectorBootstrapToken({
        tokenHash: "hash_bootstrap",
        workspaceId: "ws_acme_01",
        workspaceSlug: "acme",
        issuedByUserId: "user_01",
        issuedAt: "2026-04-07T18:00:00Z",
        expiresAt: "2026-04-07T18:30:00Z",
        consumedAt: null,
        revokedAt: null,
      });
      store.putCommand({
        command: {
          schemaVersion: "cloud-sync.v1",
          commandId: "cmd_01",
          connectorId: "conn_01",
          workspaceId: "ws_acme_01",
          repository: {
            owner: "acme",
            name: "platform-ui",
          },
          issuedAt: "2026-04-07T18:01:00Z",
          expiresAt: "2099-04-07T18:31:00Z",
          type: "create_commit",
          payload: {
            message: "chore: commit",
            stageAll: true,
          },
        },
        status: "pending",
        updatedAt: "2026-04-07T18:01:00Z",
        acknowledgedAt: null,
        leaseExpiresAt: null,
        attemptCount: 0,
        nextAttemptAt: null,
        lastMessage: null,
        result: null,
      });

      const updated = store.updateCommandStatus({
        commandId: "cmd_01",
        status: "completed",
        updatedAt: "2026-04-07T18:02:00Z",
        lastMessage: "Created commit abc1234.",
      });

      expect(store.getConnectorBootstrapToken("hash_bootstrap")?.workspaceSlug).toBe("acme");
      expect(updated?.status).toBe("completed");
      expect(updated?.lastMessage).toContain("abc1234");
    } finally {
      store.close();
    }
  });

  it("reclaims an acknowledged command after its lease expires", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-control-plane-state-"));
    tempDirs.push(tempDir);
    const store = new ControlPlaneStateStore(path.join(tempDir, "control-plane.db"));

    try {
      store.putCommand({
        command: {
          schemaVersion: "cloud-sync.v1",
          commandId: "cmd_reclaim_01",
          connectorId: "conn_01",
          workspaceId: "ws_acme_01",
          repository: {
            owner: "acme",
            name: "platform-ui",
          },
          issuedAt: "2026-04-07T18:01:00Z",
          expiresAt: "2099-04-07T18:31:00Z",
          type: "create_commit",
          payload: {
            message: "chore: commit",
            stageAll: true,
          },
        },
        status: "acked",
        updatedAt: "2026-04-07T18:02:00Z",
        acknowledgedAt: "2026-04-07T18:02:00Z",
        leaseExpiresAt: "2026-04-07T18:03:00Z",
        attemptCount: 1,
        nextAttemptAt: null,
        lastMessage: "Connector received command.",
        result: null,
      });

      const claimed = store.claimDispatchableCommands({
        connectorId: "conn_01",
        claimedAt: "2026-04-07T18:04:00Z",
        leaseExpiresAt: "2026-04-07T18:09:00Z",
      });

      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.status).toBe("pending");
      expect(claimed[0]?.attemptCount).toBe(2);
      expect(claimed[0]?.lastMessage).toContain("lease expired");
    } finally {
      store.close();
    }
  });

  it("revokes connector access tokens and retries failed commands", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-control-plane-state-"));
    tempDirs.push(tempDir);
    const store = new ControlPlaneStateStore(path.join(tempDir, "control-plane.db"));

    try {
      store.putConnector({
        id: "conn_02",
        workspaceId: "ws_acme_01",
        workspaceSlug: "acme",
        connectorName: "Desktop connector",
        machineName: "geoffrey-studio",
        connectorVersion: "0.1.0",
        platform: {
          os: "darwin",
          arch: "arm64",
          hostname: "geoffrey-studio",
        },
        capabilities: ["git_push"],
        repository: {
          provider: "github",
          repo: {
            owner: "acme",
            name: "platform-ui",
          },
          remoteUrl: "git@github.com:acme/platform-ui.git",
          defaultBranch: "main",
          currentBranch: "feature/live",
          headSha: "abcdef1234567",
          isDirty: false,
          aheadBy: 0,
          behindBy: 0,
          workspaceRoot: "/Users/me/code/platform-ui",
          lastFetchedAt: null,
        },
        status: "active",
        registeredAt: "2026-04-07T18:00:00Z",
        lastSeenAt: "2026-04-07T18:00:00Z",
      });
      store.putConnectorToken({
        tokenHash: "hash_connector_02",
        connectorId: "conn_02",
        workspaceId: "ws_acme_01",
        issuedAt: "2026-04-07T18:00:00Z",
        expiresAt: "2026-05-07T18:00:00Z",
        revokedAt: null,
      });
      store.putCommand({
        command: {
          schemaVersion: "cloud-sync.v1",
          commandId: "cmd_retry_01",
          connectorId: "conn_02",
          workspaceId: "ws_acme_01",
          repository: {
            owner: "acme",
            name: "platform-ui",
          },
          issuedAt: "2026-04-07T18:01:00Z",
          expiresAt: "2099-04-07T18:31:00Z",
          type: "push_branch",
          payload: {
            branch: "feature/live",
          },
        },
        status: "failed",
        updatedAt: "2026-04-07T18:04:00Z",
        acknowledgedAt: "2026-04-07T18:02:00Z",
        leaseExpiresAt: null,
        attemptCount: 1,
        nextAttemptAt: null,
        lastMessage: "Push failed.",
        result: null,
      });

      const revoked = store.revokeConnector("conn_02", "2026-04-07T18:05:00Z");
      const retried = store.retryCommand("cmd_retry_01", "2026-04-07T18:06:00Z");

      expect(revoked?.status).toBe("revoked");
      expect(store.listConnectorTokens("conn_02")[0]?.revokedAt).toBe("2026-04-07T18:05:00Z");
      expect(retried?.status).toBe("pending");
      expect(retried?.leaseExpiresAt).toBeNull();
      expect(retried?.lastMessage).toContain("re-queued");
    } finally {
      store.close();
    }
  });

  it("holds scheduled retries until the backoff window opens", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-control-plane-state-"));
    tempDirs.push(tempDir);
    const store = new ControlPlaneStateStore(path.join(tempDir, "control-plane.db"));

    try {
      store.putCommand({
        command: {
          schemaVersion: "cloud-sync.v1",
          commandId: "cmd_retry_window_01",
          connectorId: "conn_03",
          workspaceId: "ws_acme_01",
          repository: {
            owner: "acme",
            name: "platform-ui",
          },
          issuedAt: "2026-04-07T18:01:00Z",
          expiresAt: "2099-04-07T18:31:00Z",
          type: "refresh_repo_state",
          payload: {},
        },
        status: "failed",
        updatedAt: "2026-04-07T18:02:00Z",
        acknowledgedAt: "2026-04-07T18:02:00Z",
        leaseExpiresAt: null,
        attemptCount: 1,
        nextAttemptAt: null,
        lastMessage: "Refresh failed.",
        result: null,
      });

      store.scheduleCommandRetry({
        commandId: "cmd_retry_window_01",
        scheduledAt: "2026-04-07T18:03:00Z",
        nextAttemptAt: "2026-04-07T18:05:00Z",
        message: "Refresh failed. Automatic retry scheduled for 2026-04-07T18:05:00Z.",
      });

      expect(
        store.claimDispatchableCommands({
          connectorId: "conn_03",
          claimedAt: "2026-04-07T18:04:00Z",
          leaseExpiresAt: "2026-04-07T18:09:00Z",
        }),
      ).toHaveLength(0);

      const claimed = store.claimDispatchableCommands({
        connectorId: "conn_03",
        claimedAt: "2026-04-07T18:05:00Z",
        leaseExpiresAt: "2026-04-07T18:10:00Z",
      });

      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.status).toBe("pending");
      expect(claimed[0]?.attemptCount).toBe(2);
      expect(claimed[0]?.nextAttemptAt).toBeNull();
    } finally {
      store.close();
    }
  });

  it("allows operators to reclaim commands after the connector lease expires", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-control-plane-state-"));
    tempDirs.push(tempDir);
    const store = new ControlPlaneStateStore(path.join(tempDir, "control-plane.db"));

    try {
      store.putCommand({
        command: {
          schemaVersion: "cloud-sync.v1",
          commandId: "cmd_lease_reclaim_01",
          connectorId: "conn_04",
          workspaceId: "ws_acme_01",
          repository: {
            owner: "acme",
            name: "platform-ui",
          },
          issuedAt: "2026-04-07T18:01:00Z",
          expiresAt: "2099-04-07T18:31:00Z",
          type: "open_pull_request",
          payload: {
            title: "feat: open PR",
          },
        },
        status: "acked",
        updatedAt: "2026-04-07T18:02:00Z",
        acknowledgedAt: "2026-04-07T18:02:00Z",
        leaseExpiresAt: "2026-04-07T18:03:00Z",
        attemptCount: 1,
        nextAttemptAt: null,
        lastMessage: "Connector received command.",
        result: null,
      });

      const reclaimed = store.retryCommand("cmd_lease_reclaim_01", "2026-04-07T18:05:00Z");

      expect(reclaimed?.status).toBe("pending");
      expect(reclaimed?.acknowledgedAt).toBeNull();
      expect(reclaimed?.leaseExpiresAt).toBeNull();
      expect(reclaimed?.lastMessage).toContain("lease reclaimed");
    } finally {
      store.close();
    }
  });
});
