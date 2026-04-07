import "server-only";

import { createHash } from "node:crypto";

import { withControlPlaneState } from "@/lib/backend/control-plane/state";
import { collectWorkspaceRepositoryRuntimeRecords } from "@/lib/backend/workspace/repository-inventory";

export function getWorkspaceLiveSignature(workspaceId: string): string {
  const repositorySignature = collectWorkspaceRepositoryRuntimeRecords(workspaceId)
    .map((record) => ({
      id: record.inventory.id,
      lastUpdatedAt: record.inventory.lastUpdatedAt,
      pendingApprovalCount: record.pendingApprovalCount,
      latestRunId: record.latestRun?.run_id ?? null,
      latestEventAt: record.latestRun?.latest_event?.occurred_at ?? null,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  const connectorSignature = withControlPlaneState((store) =>
    store
      .listConnectors(workspaceId)
      .map((connector) => {
        const commands = store.listCommands(connector.id);
        const events = store.listEvents(connector.id);

        return {
          id: connector.id,
          status: connector.status,
          lastSeenAt: connector.lastSeenAt,
          commandVersion: commands[0]?.updatedAt ?? null,
          eventVersion: events[0]?.ingestedAt ?? null,
        };
      })
      .sort((left, right) => left.id.localeCompare(right.id)),
  );

  return createHash("sha256")
    .update(JSON.stringify({ repositorySignature, connectorSignature }), "utf8")
    .digest("hex");
}
