import "server-only";

import type { ConnectorStatus } from "@agentgit/cloud-sync-protocol";
import { ApprovalInboxItemSchema, RunSummarySchema } from "@agentgit/schemas";

import { withControlPlaneState } from "@/lib/backend/control-plane/state";
import { getWorkspaceConnectionState } from "@/lib/backend/workspace/cloud-state";
import { actionDetailRoute, repositoryRoute, runDetailRoute } from "@/lib/navigation/routes";
import { type ActivityEvent } from "@/schemas/cloud";

export type SyncedRepositoryProjection = {
  repo: string;
  owner: string;
  name: string;
  lastUpdatedAt: string;
  connectorStatus: ConnectorStatus | "stale";
};

function buildRepoLabel(owner: string, name: string) {
  return `${owner}/${name}`;
}

function connectorStatusPriority(status: SyncedRepositoryProjection["connectorStatus"]) {
  switch (status) {
    case "active":
      return 3;
    case "stale":
      return 2;
    case "revoked":
      return 1;
    default:
      return 0;
  }
}

function upsertSyncedRepository(
  projected: Map<string, SyncedRepositoryProjection>,
  input: {
    owner: string;
    name: string;
    lastUpdatedAt: string;
    connectorStatus: SyncedRepositoryProjection["connectorStatus"];
  },
) {
  const repo = buildRepoLabel(input.owner, input.name);
  const current = projected.get(repo);
  if (!current) {
    projected.set(repo, {
      repo,
      owner: input.owner,
      name: input.name,
      lastUpdatedAt: input.lastUpdatedAt,
      connectorStatus: input.connectorStatus,
    });
    return;
  }

  const connectorStatus =
    connectorStatusPriority(input.connectorStatus) >= connectorStatusPriority(current.connectorStatus)
      ? input.connectorStatus
      : current.connectorStatus;
  const lastUpdatedAt =
    new Date(input.lastUpdatedAt).getTime() >= new Date(current.lastUpdatedAt).getTime()
      ? input.lastUpdatedAt
      : current.lastUpdatedAt;

  projected.set(repo, {
    ...current,
    lastUpdatedAt,
    connectorStatus,
  });
}

function detailPathForRunEvent(params: { owner: string; name: string; runId: string; actionId?: string }) {
  if (params.actionId) {
    return actionDetailRoute(params.owner, params.name, params.runId, params.actionId);
  }

  return runDetailRoute(params.owner, params.name, params.runId);
}

function mapSyncedRunEventToActivity(params: {
  owner: string;
  name: string;
  runId: string;
  event: { event_type: string; occurred_at: string; payload?: Record<string, unknown> | null };
}): ActivityEvent | null {
  const repo = buildRepoLabel(params.owner, params.name);
  const actionId = typeof params.event.payload?.action_id === "string" ? params.event.payload.action_id : undefined;

  switch (params.event.event_type) {
    case "approval.requested":
      return {
        id: `${params.runId}:${params.event.occurred_at}:approval-requested`,
        kind: "approval_requested",
        title: "Approval requested",
        message: `A governed action in ${repo} requires human review.`,
        repo,
        actorLabel: "AgentGit policy engine",
        runId: params.runId,
        actionId,
        detailPath: detailPathForRunEvent({
          owner: params.owner,
          name: params.name,
          runId: params.runId,
          actionId,
        }),
        createdAt: params.event.occurred_at,
        tone: "accent",
      };
    case "approval.resolved":
      return {
        id: `${params.runId}:${params.event.occurred_at}:approval-resolved`,
        kind: "approval_resolved",
        title: "Approval resolved",
        message: `An approval gate in ${repo} was resolved.`,
        repo,
        actorLabel: "Workspace reviewer",
        runId: params.runId,
        actionId,
        detailPath: detailPathForRunEvent({
          owner: params.owner,
          name: params.name,
          runId: params.runId,
          actionId,
        }),
        createdAt: params.event.occurred_at,
        tone: "warning",
      };
    case "execution.completed":
      return {
        id: `${params.runId}:${params.event.occurred_at}:execution-completed`,
        kind: "run_completed",
        title: "Run completed",
        message: `A governed execution completed in ${repo}.`,
        repo,
        actorLabel: "AgentGit runtime",
        runId: params.runId,
        actionId,
        detailPath: detailPathForRunEvent({
          owner: params.owner,
          name: params.name,
          runId: params.runId,
          actionId,
        }),
        createdAt: params.event.occurred_at,
        tone: "neutral",
      };
    case "execution.failed":
    case "execution.outcome_unknown":
      return {
        id: `${params.runId}:${params.event.occurred_at}:execution-failed`,
        kind: "run_failed",
        title: "Run failed",
        message: `A governed execution failed in ${repo}.`,
        repo,
        actorLabel: "AgentGit runtime",
        runId: params.runId,
        actionId,
        detailPath: detailPathForRunEvent({
          owner: params.owner,
          name: params.name,
          runId: params.runId,
          actionId,
        }),
        createdAt: params.event.occurred_at,
        tone: "error",
      };
    case "recovery.executed":
      return {
        id: `${params.runId}:${params.event.occurred_at}:recovery-executed`,
        kind: "snapshot_restored",
        title: "Recovery executed",
        message: `Snapshot recovery executed for ${repo}.`,
        repo,
        actorLabel: "AgentGit recovery engine",
        runId: params.runId,
        actionId,
        detailPath: detailPathForRunEvent({
          owner: params.owner,
          name: params.name,
          runId: params.runId,
          actionId,
        }),
        createdAt: params.event.occurred_at,
        tone: "warning",
      };
    case "policy.evaluated":
      return {
        id: `${params.runId}:${params.event.occurred_at}:policy-evaluated`,
        kind: "policy_changed",
        title: "Policy gate evaluated",
        message: `A policy decision was recorded for ${repo}.`,
        repo,
        actorLabel: "AgentGit policy engine",
        runId: params.runId,
        actionId,
        detailPath: detailPathForRunEvent({
          owner: params.owner,
          name: params.name,
          runId: params.runId,
          actionId,
        }),
        createdAt: params.event.occurred_at,
        tone: "neutral",
      };
    default:
      return null;
  }
}

export async function listWorkspaceSyncedRepositories(workspaceId: string): Promise<SyncedRepositoryProjection[]> {
  if (!(await getWorkspaceConnectionState(workspaceId))) {
    return [];
  }

  return withControlPlaneState((store) => {
    const projected = new Map<string, SyncedRepositoryProjection>();

    for (const connector of store.listConnectors(workspaceId)) {
      upsertSyncedRepository(projected, {
        owner: connector.repository.repo.owner,
        name: connector.repository.repo.name,
        lastUpdatedAt: connector.lastSeenAt,
        connectorStatus: connector.status,
      });

      const heartbeat = store.getHeartbeat(connector.id);
      if (heartbeat) {
        upsertSyncedRepository(projected, {
          owner: heartbeat.repository.repo.owner,
          name: heartbeat.repository.repo.name,
          lastUpdatedAt: heartbeat.receivedAt,
          connectorStatus: connector.status,
        });
      }
    }

    for (const event of store.listEvents()) {
      if (event.event.workspaceId !== workspaceId) {
        continue;
      }

      upsertSyncedRepository(projected, {
        owner: event.event.repository.owner,
        name: event.event.repository.name,
        lastUpdatedAt: event.event.occurredAt,
        connectorStatus: "stale",
      });
    }

    for (const command of store.listCommands()) {
      if (command.command.workspaceId !== workspaceId) {
        continue;
      }

      upsertSyncedRepository(projected, {
        owner: command.command.repository.owner,
        name: command.command.repository.name,
        lastUpdatedAt: command.updatedAt,
        connectorStatus: "stale",
      });
    }

    return Array.from(projected.values()).sort(
      (left, right) => new Date(right.lastUpdatedAt).getTime() - new Date(left.lastUpdatedAt).getTime(),
    );
  });
}

export async function listWorkspaceSyncedActivityEvents(workspaceId: string): Promise<ActivityEvent[]> {
  if (!(await getWorkspaceConnectionState(workspaceId))) {
    return [];
  }

  return withControlPlaneState((store) => {
    const items: ActivityEvent[] = [];

    for (const record of store.listEvents()) {
      if (record.event.workspaceId !== workspaceId) {
        continue;
      }

      if (record.event.type === "run.lifecycle") {
        const summary = RunSummarySchema.safeParse(record.event.payload.summary);
        if (summary.success) {
          items.push({
            id: `lifecycle:${record.event.eventId}`,
            kind: "run_started",
            title: "Run synchronized",
            message: `Connector synchronized governed run ${summary.data.workflow_name}.`,
            repo: buildRepoLabel(record.event.repository.owner, record.event.repository.name),
            actorLabel: "AgentGit cloud connector",
            runId: summary.data.run_id,
            detailPath: runDetailRoute(
              record.event.repository.owner,
              record.event.repository.name,
              summary.data.run_id,
            ),
            createdAt: record.event.occurredAt,
            tone: "neutral",
          });
        }
        continue;
      }

      if (record.event.type === "run.event") {
        const runId = typeof record.event.payload.runId === "string" ? record.event.payload.runId : null;
        const event =
          typeof record.event.payload.event === "object" && record.event.payload.event !== null
            ? (record.event.payload.event as {
                event_type?: string;
                occurred_at?: string;
                payload?: Record<string, unknown> | null;
              })
            : null;
        const occurredAt = typeof event?.occurred_at === "string" ? event.occurred_at : record.event.occurredAt;

        if (!runId || typeof event?.event_type !== "string") {
          continue;
        }

        const mapped = mapSyncedRunEventToActivity({
          owner: record.event.repository.owner,
          name: record.event.repository.name,
          runId,
          event: {
            event_type: event.event_type,
            occurred_at: occurredAt,
            payload: event.payload ?? null,
          },
        });
        if (mapped) {
          items.push(mapped);
        }
        continue;
      }

      if (record.event.type === "approval.requested" || record.event.type === "approval.resolution") {
        const approval = ApprovalInboxItemSchema.safeParse(record.event.payload);
        if (!approval.success) {
          continue;
        }

        const repo = buildRepoLabel(record.event.repository.owner, record.event.repository.name);
        items.push({
          id: `approval:${approval.data.approval_id}:${record.event.type}`,
          kind: record.event.type === "approval.requested" ? "approval_requested" : "approval_resolved",
          title: record.event.type === "approval.requested" ? "Approval requested" : "Approval resolved",
          message:
            record.event.type === "approval.requested"
              ? `A governed action in ${repo} requires human review.`
              : `An approval gate in ${repo} was resolved.`,
          repo,
          actorLabel: record.event.type === "approval.requested" ? "AgentGit policy engine" : "Workspace reviewer",
          runId: approval.data.run_id,
          actionId: approval.data.action_id,
          detailPath: actionDetailRoute(
            record.event.repository.owner,
            record.event.repository.name,
            approval.data.run_id,
            approval.data.action_id,
          ),
          createdAt: record.event.occurredAt,
          tone: record.event.type === "approval.requested" ? "accent" : "warning",
        });
        continue;
      }

      if (record.event.type === "policy.state") {
        items.push({
          id: `policy:${record.event.eventId}`,
          kind: "policy_changed",
          title: "Policy synchronized",
          message: `Policy state synchronized for ${buildRepoLabel(record.event.repository.owner, record.event.repository.name)}.`,
          repo: buildRepoLabel(record.event.repository.owner, record.event.repository.name),
          actorLabel: "AgentGit cloud connector",
          detailPath: repositoryRoute(record.event.repository.owner, record.event.repository.name),
          createdAt: record.event.occurredAt,
          tone: "neutral",
        });
      }
    }

    return items.sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  });
}
