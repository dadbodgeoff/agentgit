import { describe, expect, it } from "vitest";

import { CLOUD_SYNC_SCHEMA_VERSION, ConnectorRegistrationRequestSchema, ConnectorEventEnvelopeSchema } from "./index.js";

describe("cloud sync protocol schemas", () => {
  it("parses a connector registration request", () => {
    const parsed = ConnectorRegistrationRequestSchema.parse({
      schemaVersion: CLOUD_SYNC_SCHEMA_VERSION,
      workspaceId: "ws_acme_01",
      connectorName: "Geoffrey MacBook connector",
      machineName: "geoffrey-mbp",
      connectorVersion: "0.1.0",
      platform: {
        os: "darwin",
        arch: "arm64",
        hostname: "geoffrey-mbp",
      },
      capabilities: ["repo_state_sync", "run_event_sync"],
      repository: {
        provider: "github",
        repo: {
          owner: "acme",
          name: "platform-ui",
        },
        remoteUrl: "git@github.com:acme/platform-ui.git",
        defaultBranch: "main",
        currentBranch: "feature/sync",
        headSha: "0123456789abcdef",
        isDirty: true,
        aheadBy: 1,
        behindBy: 0,
        workspaceRoot: "/Users/me/code/platform-ui",
        lastFetchedAt: "2026-04-07T18:00:00Z",
      },
    });

    expect(parsed.repository.repo.owner).toBe("acme");
  });

  it("parses a connector event envelope", () => {
    const parsed = ConnectorEventEnvelopeSchema.parse({
      schemaVersion: CLOUD_SYNC_SCHEMA_VERSION,
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
    });

    expect(parsed.type).toBe("repo_state.snapshot");
  });
});
