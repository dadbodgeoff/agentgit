import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withControlPlaneState } from "@/lib/backend/control-plane/state";
import {
  ConnectorAccessError,
  findConnectorForRepository,
  getRepositoryConnectorAvailability,
  listWorkspaceConnectors,
  retryConnectorCommand,
  queueConnectorCommand,
} from "@/lib/backend/control-plane/connectors";
import type { WorkspaceSession } from "@/schemas/cloud";

function putConnectorFixture(params: {
  id: string;
  workspaceRoot: string;
  lastSeenAt: string;
  status?: "active" | "revoked";
}) {
  withControlPlaneState((store) => {
    store.putConnector({
      id: params.id,
      workspaceId: "ws_acme_01",
      workspaceSlug: "acme",
      connectorName: `${params.id}-connector`,
      machineName: `${params.id}-machine`,
      connectorVersion: "0.1.0",
      platform: {
        os: "darwin",
        arch: "arm64",
        hostname: `${params.id}-host`,
      },
      capabilities: ["repo_state_sync", "restore_execution"],
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
        workspaceRoot: params.workspaceRoot,
        lastFetchedAt: null,
      },
      status: params.status ?? "active",
      registeredAt: "2026-04-07T18:00:00Z",
      lastSeenAt: params.lastSeenAt,
    });
    store.putConnectorToken({
      tokenHash: `token_${params.id}`,
      connectorId: params.id,
      workspaceId: "ws_acme_01",
      issuedAt: "2026-04-07T18:00:00Z",
      expiresAt: "2026-05-07T18:00:00Z",
      revokedAt: params.status === "revoked" ? "2026-04-07T18:10:00Z" : null,
    });
  });
}

describe("connector routing and dispatch safety", () => {
  const tempDirs: string[] = [];
  const originalAgentGitRoot = process.env.AGENTGIT_ROOT;
  const originalGitHubToken = process.env.AGENTGIT_GITHUB_TOKEN;

  afterEach(() => {
    if (originalAgentGitRoot === undefined) {
      delete process.env.AGENTGIT_ROOT;
    } else {
      process.env.AGENTGIT_ROOT = originalAgentGitRoot;
    }

    if (originalGitHubToken === undefined) {
      delete process.env.AGENTGIT_GITHUB_TOKEN;
    } else {
      process.env.AGENTGIT_GITHUB_TOKEN = originalGitHubToken;
    }

    for (const tempDir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("selects only active connectors bound to the exact repository workspace root", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-connectors-"));
    tempDirs.push(tempDir);
    process.env.AGENTGIT_ROOT = tempDir;

    putConnectorFixture({
      id: "conn_matching_healthy",
      workspaceRoot: "/tmp/workspaces/platform-ui",
      lastSeenAt: "2026-04-07T18:09:00Z",
    });
    putConnectorFixture({
      id: "conn_matching_stale",
      workspaceRoot: "/tmp/workspaces/platform-ui",
      lastSeenAt: "2026-04-07T17:30:00Z",
    });
    putConnectorFixture({
      id: "conn_matching_revoked",
      workspaceRoot: "/tmp/workspaces/platform-ui",
      lastSeenAt: "2026-04-07T18:10:00Z",
      status: "revoked",
    });
    putConnectorFixture({
      id: "conn_other_root",
      workspaceRoot: "/tmp/other/platform-ui",
      lastSeenAt: "2026-04-07T18:20:00Z",
    });

    const connector = findConnectorForRepository(
      "ws_acme_01",
      "acme",
      "platform-ui",
      "/tmp/workspaces/platform-ui",
      "2026-04-07T18:12:00Z",
    );

    expect(connector?.id).toBe("conn_matching_healthy");
  });

  it("reports stale connector availability when delivery health has degraded", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-connectors-"));
    tempDirs.push(tempDir);
    process.env.AGENTGIT_ROOT = tempDir;

    putConnectorFixture({
      id: "conn_stale",
      workspaceRoot: "/tmp/workspaces/platform-ui",
      lastSeenAt: "2026-04-07T17:30:00Z",
    });

    const availability = getRepositoryConnectorAvailability(
      "ws_acme_01",
      "acme",
      "platform-ui",
      "/tmp/workspaces/platform-ui",
      "2026-04-07T18:12:00Z",
    );

    expect(availability).toMatchObject({
      status: "stale",
      connectorId: "conn_stale",
      machineName: "conn_stale-machine",
    });
    expect(availability.reason).toContain("No heartbeat seen");
  });

  it("refuses to queue commands onto stale or revoked connectors", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-connectors-"));
    tempDirs.push(tempDir);
    process.env.AGENTGIT_ROOT = tempDir;

    putConnectorFixture({
      id: "conn_stale",
      workspaceRoot: "/tmp/workspaces/platform-ui",
      lastSeenAt: "2026-04-07T17:30:00Z",
    });
    putConnectorFixture({
      id: "conn_revoked",
      workspaceRoot: "/tmp/workspaces/platform-ui",
      lastSeenAt: "2026-04-07T18:09:00Z",
      status: "revoked",
    });

    const workspaceSession = {
      user: {
        id: "user_01",
        name: "Admin",
        email: "admin@agentgit.dev",
      },
      activeWorkspace: {
        id: "ws_acme_01",
        name: "Acme",
        slug: "acme",
        role: "admin",
      },
    } satisfies WorkspaceSession;

    expect(() =>
      queueConnectorCommand(
        workspaceSession,
        "conn_stale",
        {
          type: "execute_restore",
          snapshotId: "snap_01",
        },
        "2026-04-07T18:12:00Z",
      ),
    ).toThrowError(ConnectorAccessError);

    expect(() =>
      queueConnectorCommand(
        workspaceSession,
        "conn_revoked",
        {
          type: "execute_restore",
          snapshotId: "snap_01",
        },
        "2026-04-07T18:12:00Z",
      ),
    ).toThrowError(ConnectorAccessError);
  });

  it("refuses to replay commands that already completed successfully", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-connectors-"));
    tempDirs.push(tempDir);
    process.env.AGENTGIT_ROOT = tempDir;

    putConnectorFixture({
      id: "conn_completed",
      workspaceRoot: "/tmp/workspaces/platform-ui",
      lastSeenAt: "2026-04-07T18:09:00Z",
    });

    withControlPlaneState((store) => {
      store.putCommand({
        command: {
          schemaVersion: "cloud-sync.v1",
          commandId: "cmd_completed",
          connectorId: "conn_completed",
          workspaceId: "ws_acme_01",
          repository: {
            owner: "acme",
            name: "platform-ui",
          },
          issuedAt: "2026-04-07T18:00:00Z",
          expiresAt: "2026-04-08T18:00:00Z",
          type: "refresh_repo_state",
          payload: {
            forceFullSync: true,
          },
        },
        status: "completed",
        updatedAt: "2026-04-07T18:10:00Z",
        acknowledgedAt: "2026-04-07T18:05:00Z",
        leaseExpiresAt: null,
        attemptCount: 1,
        nextAttemptAt: null,
        lastMessage: "Refresh completed.",
        result: {
          type: "refresh_repo_state",
          publishedEventCount: 1,
          includesSnapshots: true,
          syncedAt: "2026-04-07T18:10:00Z",
        },
      });
    });

    expect(() => retryConnectorCommand("ws_acme_01", "cmd_completed", "2026-04-07T18:12:00Z")).toThrowError(
      ConnectorAccessError,
    );
  });

  it("allows lease-expired commands to be reclaimed by operators", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-connectors-"));
    tempDirs.push(tempDir);
    process.env.AGENTGIT_ROOT = tempDir;

    putConnectorFixture({
      id: "conn_leased",
      workspaceRoot: "/tmp/workspaces/platform-ui",
      lastSeenAt: "2026-04-07T18:09:00Z",
    });

    withControlPlaneState((store) => {
      store.putCommand({
        command: {
          schemaVersion: "cloud-sync.v1",
          commandId: "cmd_leased",
          connectorId: "conn_leased",
          workspaceId: "ws_acme_01",
          repository: {
            owner: "acme",
            name: "platform-ui",
          },
          issuedAt: "2026-04-07T18:00:00Z",
          expiresAt: "2026-04-08T18:00:00Z",
          type: "open_pull_request",
          payload: {
            title: "feat: governed PR",
          },
        },
        status: "acked",
        updatedAt: "2026-04-07T18:03:00Z",
        acknowledgedAt: "2026-04-07T18:03:00Z",
        leaseExpiresAt: "2026-04-07T18:04:00Z",
        attemptCount: 1,
        nextAttemptAt: null,
        lastMessage: "Connector received command.",
        result: null,
      });
    });

    const retried = retryConnectorCommand("ws_acme_01", "cmd_leased", "2026-04-07T18:12:00Z");
    expect(retried.status).toBe("pending");
    expect(retried.message).toContain("lease expired");
  });

  it("enriches connector inventory with provider-verified repository identity", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-connectors-"));
    tempDirs.push(tempDir);
    process.env.AGENTGIT_ROOT = tempDir;
    process.env.AGENTGIT_GITHUB_TOKEN = "ghp_test";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://api.github.com/repos/acme/platform-ui");
      return new Response(
        JSON.stringify({
          node_id: "R_kgDOTest",
          html_url: "https://github.com/acme/platform-ui",
          visibility: "private",
          default_branch: "trunk",
          name: "platform-ui",
          owner: {
            login: "acme",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      putConnectorFixture({
        id: "conn_verified",
        workspaceRoot: "/tmp/workspaces/platform-ui",
        lastSeenAt: "2026-04-07T18:09:00Z",
      });

      const inventory = await listWorkspaceConnectors("ws_acme_01", "2026-04-07T18:12:00Z");
      expect(inventory.items[0]?.providerIdentity).toMatchObject({
        provider: "github",
        status: "drifted",
        defaultBranch: "trunk",
        repositoryUrl: "https://github.com/acme/platform-ui",
        visibility: "private",
      });
    } finally {
      delete process.env.AGENTGIT_GITHUB_TOKEN;
      globalThis.fetch = originalFetch;
    }
  });

  it("adds direct command links for operator follow-through", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-connectors-"));
    tempDirs.push(tempDir);
    process.env.AGENTGIT_ROOT = tempDir;

    putConnectorFixture({
      id: "conn_links",
      workspaceRoot: "/tmp/workspaces/platform-ui",
      lastSeenAt: "2026-04-07T18:09:00Z",
    });

    withControlPlaneState((store) => {
      store.putCommand({
        command: {
          schemaVersion: "cloud-sync.v1",
          commandId: "cmd_pr_links",
          connectorId: "conn_links",
          workspaceId: "ws_acme_01",
          repository: {
            owner: "acme",
            name: "platform-ui",
          },
          issuedAt: "2026-04-07T18:01:00Z",
          expiresAt: "2026-04-08T18:01:00Z",
          type: "open_pull_request",
          payload: {
            title: "feat: governed PR",
          },
        },
        status: "completed",
        updatedAt: "2026-04-07T18:03:00Z",
        acknowledgedAt: "2026-04-07T18:02:00Z",
        leaseExpiresAt: null,
        attemptCount: 1,
        nextAttemptAt: null,
        lastMessage: "Opened PR.",
        result: {
          type: "open_pull_request",
          provider: "github",
          pullRequestUrl: "https://github.com/acme/platform-ui/pull/42",
          pullRequestNumber: 42,
          baseBranch: "main",
          headBranch: "feature/governed",
          draft: false,
        },
      });
    });

    const inventory = await listWorkspaceConnectors("ws_acme_01", "2026-04-07T18:12:00Z");
    expect(inventory.items[0]?.recentCommands[0]).toMatchObject({
      detailPath: "/app/repos/acme/platform-ui",
      externalUrl: "https://github.com/acme/platform-ui/pull/42",
    });
  });
});
