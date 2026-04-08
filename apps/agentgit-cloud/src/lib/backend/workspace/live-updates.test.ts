import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const repositoryRecords: Array<{
  inventory: { id: string; lastUpdatedAt: string };
  pendingApprovalCount: number;
  latestRun: { run_id: string; latest_event: { occurred_at: string } } | null;
}> = [];

const commands = [
  { updatedAt: "2026-04-07T18:01:00Z" },
  { updatedAt: "2026-04-07T18:05:00Z" },
];

const events = [
  { ingestedAt: "2026-04-07T18:02:00Z" },
  { ingestedAt: "2026-04-07T18:06:00Z" },
];

vi.mock("@/lib/backend/workspace/repository-inventory", () => ({
  collectWorkspaceRepositoryRuntimeRecords: vi.fn(() => repositoryRecords),
}));

vi.mock("@/lib/backend/control-plane/state", () => ({
  withControlPlaneState: (run: (store: unknown) => unknown) =>
    run({
      listConnectors: () => [
        {
          id: "conn_01",
          status: "active",
          lastSeenAt: "2026-04-07T18:00:00Z",
        },
      ],
      listCommands: () => commands,
      listEvents: () => events,
    }),
}));

describe("workspace live updates", () => {
  beforeEach(() => {
    repositoryRecords.splice(0, repositoryRecords.length);
    commands[0]!.updatedAt = "2026-04-07T18:01:00Z";
    commands[1]!.updatedAt = "2026-04-07T18:05:00Z";
    events[0]!.ingestedAt = "2026-04-07T18:02:00Z";
    events[1]!.ingestedAt = "2026-04-07T18:06:00Z";
  });

  it("tracks the latest command and event timestamps even when state rows are unsorted", async () => {
    const { getWorkspaceLiveSignature } = await import("./live-updates");

    const before = getWorkspaceLiveSignature("ws_acme_01");

    commands[1]!.updatedAt = "2026-04-07T18:07:00Z";
    events[1]!.ingestedAt = "2026-04-07T18:08:00Z";

    const after = getWorkspaceLiveSignature("ws_acme_01");

    expect(after).not.toBe(before);
  });
});
