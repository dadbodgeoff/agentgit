import "server-only";

import { withControlPlaneState } from "@/lib/backend/control-plane/state";
import { actionDetailRoute, repositoryRoute, runDetailRoute } from "@/lib/navigation/routes";
import { AuditLogResponseSchema, type AuditEntry, type AuditExportFormat } from "@/schemas/cloud";
import { listWorkspaceApprovals, listWorkspaceRunContexts } from "@/lib/backend/workspace/workspace-runtime";
import { paginateItems } from "@/lib/pagination/cursor";

function repoLabel(owner: string, name: string) {
  return `${owner}/${name}`;
}

type WorkspaceAuditLogOptions = {
  from?: string | null;
  to?: string | null;
  cursor?: string | null;
  limit?: number | null;
};

type WorkspaceAuditExport = {
  contentType: string;
  fileName: string;
  body: string;
};

function describeConnectorAuditDetails(command: {
  command: { type: string; payload?: Record<string, unknown> | null };
  status: string;
  lastMessage: string | null;
  nextAttemptAt: string | null;
  result?: Record<string, unknown> | null;
}) {
  if (
    command.result &&
    command.command.type === "open_pull_request" &&
    typeof command.result.pullRequestUrl === "string"
  ) {
    return `Provider PR opened at ${command.result.pullRequestUrl}.`;
  }

  if (command.result && command.command.type === "execute_restore" && typeof command.result.snapshotId === "string") {
    return command.status === "completed"
      ? `Snapshot ${command.result.snapshotId} restored on the local connector.`
      : `Snapshot ${command.result.snapshotId} restore failed or needs manual follow-up.`;
  }

  if (command.command.type === "replay_run") {
    if (command.status === "completed" && typeof command.result?.replayRunId === "string") {
      return `Replay produced run ${command.result.replayRunId} on the local connector.`;
    }

    if (typeof command.command.payload?.sourceRunId === "string") {
      return `Replay for source run ${command.command.payload.sourceRunId} is ${command.status}.`;
    }
  }

  if (command.nextAttemptAt) {
    return `${command.lastMessage ?? `${command.command.type} is ${command.status}.`} Retry scheduled for ${command.nextAttemptAt}.`;
  }

  return command.lastMessage ?? `${command.command.type} is ${command.status}.`;
}

function detailPathForCommand(command: {
  command: { repository: { owner: string; name: string }; payload?: Record<string, unknown> | null };
  result?: Record<string, unknown> | null;
}) {
  const owner = command.command.repository.owner;
  const name = command.command.repository.name;

  if (typeof command.result?.replayRunId === "string") {
    return runDetailRoute(owner, name, command.result.replayRunId);
  }

  if (typeof command.command.payload?.sourceRunId === "string") {
    return runDetailRoute(owner, name, command.command.payload.sourceRunId);
  }

  if (typeof command.result?.runId === "string" && typeof command.result?.actionId === "string") {
    return actionDetailRoute(owner, name, command.result.runId, command.result.actionId);
  }

  if (typeof command.result?.runId === "string") {
    return runDetailRoute(owner, name, command.result.runId);
  }

  return repositoryRoute(owner, name);
}

function externalUrlForCommand(command: { result?: Record<string, unknown> | null }) {
  return typeof command.result?.pullRequestUrl === "string" ? command.result.pullRequestUrl : null;
}

function csvCell(value: string | null | undefined) {
  const normalized = value ?? "";
  return `"${normalized.replaceAll('"', '""')}"`;
}

function formatAuditExportTimestamp(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toISOString().replace(/[:.]/g, "-");
}

function filterAuditItems(items: AuditEntry[], options: WorkspaceAuditLogOptions) {
  const fromTime = options.from ? new Date(options.from).getTime() : null;
  const toTime = options.to ? new Date(options.to).getTime() : null;

  return items.filter((item) => {
    const occurredAt = new Date(item.occurredAt).getTime();
    if (fromTime !== null && occurredAt < fromTime) {
      return false;
    }

    if (toTime !== null && occurredAt > toTime) {
      return false;
    }

    return true;
  });
}

async function collectWorkspaceAuditItems(workspaceId: string) {
  const items: AuditEntry[] = [];

  for (const { repository, approval } of await listWorkspaceApprovals(workspaceId)) {
    items.push({
      id: approval.approval_id,
      occurredAt: approval.resolved_at ?? approval.requested_at,
      actorLabel: approval.resolved_at ? "Workspace reviewer" : "AgentGit policy engine",
      actorType: approval.resolved_at ? "human" : "system",
      category: "approval",
      action: approval.resolved_at ? `approval_${approval.status}` : "approval_requested",
      target: approval.action_summary,
      outcome: approval.status === "approved" ? "success" : approval.status === "denied" ? "failure" : "info",
      repo: repoLabel(repository.inventory.owner, repository.inventory.name),
      runId: approval.run_id,
      actionId: approval.action_id,
      details: approval.primary_reason?.message ?? "Approval decision recorded in the governed journal.",
    });
  }

  for (const context of await listWorkspaceRunContexts(workspaceId)) {
    for (const event of context.events) {
      if (event.event_type !== "recovery.executed" && event.event_type !== "execution.failed") {
        continue;
      }

      items.push({
        id: `${context.run.run_id}:${event.sequence}`,
        occurredAt: event.occurred_at,
        actorLabel: "AgentGit runtime",
        actorType: "system",
        category: event.event_type === "recovery.executed" ? "recovery" : "run",
        action: event.event_type,
        target: context.run.workflow_name,
        outcome: event.event_type === "recovery.executed" ? "warning" : "failure",
        repo: repoLabel(context.repository.inventory.owner, context.repository.inventory.name),
        runId: context.run.run_id,
        actionId: typeof event.payload?.action_id === "string" ? event.payload.action_id : null,
        details: `Journal event ${event.event_type} captured for governed run ${context.run.run_id}.`,
      });
    }
  }

  withControlPlaneState((store) => {
    for (const command of store.listCommands()) {
      if (command.command.workspaceId !== workspaceId) {
        continue;
      }

      items.push({
        id: `command:${command.command.commandId}`,
        occurredAt: command.updatedAt,
        actorLabel: "AgentGit cloud connector",
        actorType: "system",
        category: "connector",
        action: command.command.type,
        target: `${command.command.repository.owner}/${command.command.repository.name}`,
        outcome:
          command.status === "failed"
            ? "failure"
            : command.status === "expired"
              ? "warning"
              : command.status === "completed"
                ? "success"
                : "info",
        repo: `${command.command.repository.owner}/${command.command.repository.name}`,
        runId: null,
        actionId: null,
        detailPath: detailPathForCommand(command),
        externalUrl: externalUrlForCommand(command),
        details: describeConnectorAuditDetails(command),
      });
    }

    for (const event of store.listEvents()) {
      if (event.event.workspaceId !== workspaceId || event.event.type !== "policy.state") {
        continue;
      }

      items.push({
        id: `event:${event.event.eventId}`,
        occurredAt: event.event.occurredAt,
        actorLabel: "Local connector",
        actorType: "system",
        category: "policy",
        action: event.event.type,
        target: `${event.event.repository.owner}/${event.event.repository.name}`,
        outcome: "info",
        repo: `${event.event.repository.owner}/${event.event.repository.name}`,
        runId: null,
        actionId: null,
        details: "Policy state was synchronized into the control plane.",
      });
    }
  });

  return items.sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime());
}

function serializeAuditExport(
  items: AuditEntry[],
  workspaceId: string,
  format: AuditExportFormat,
  options: WorkspaceAuditLogOptions,
): WorkspaceAuditExport {
  const exportedAt = new Date().toISOString();
  const fileBase = `audit-${workspaceId}-${formatAuditExportTimestamp(exportedAt)}`;

  if (format === "json") {
    return {
      contentType: "application/json; charset=utf-8",
      fileName: `${fileBase}.json`,
      body: JSON.stringify(
        {
          workspaceId,
          exportedAt,
          filters: {
            from: options.from ?? null,
            to: options.to ?? null,
          },
          total: items.length,
          items,
        },
        null,
        2,
      ),
    };
  }

  const header = [
    "id",
    "occurredAt",
    "actorLabel",
    "actorType",
    "category",
    "action",
    "target",
    "outcome",
    "repo",
    "runId",
    "actionId",
    "detailPath",
    "externalUrl",
    "details",
  ];
  const lines = items.map((item) =>
    [
      item.id,
      item.occurredAt,
      item.actorLabel,
      item.actorType,
      item.category,
      item.action,
      item.target,
      item.outcome,
      item.repo,
      item.runId,
      item.actionId,
      item.detailPath ?? null,
      item.externalUrl ?? null,
      item.details,
    ]
      .map((value) => csvCell(typeof value === "string" ? value : value))
      .join(","),
  );

  return {
    contentType: "text/csv; charset=utf-8",
    fileName: `${fileBase}.csv`,
    body: [header.join(","), ...lines].join("\n"),
  };
}

export async function listWorkspaceAuditLog(workspaceId: string, options: WorkspaceAuditLogOptions = {}) {
  const sorted = filterAuditItems(await collectWorkspaceAuditItems(workspaceId), options);
  const limit = options.limit ?? 100;
  const page =
    limit === null
      ? {
          items: sorted,
          total: sorted.length,
          page_size: sorted.length === 0 ? 25 : sorted.length,
          next_cursor: null,
          has_more: false,
        }
      : paginateItems(sorted, { cursor: options.cursor ?? null, limit });
  return AuditLogResponseSchema.parse({
    ...page,
    generatedAt: new Date().toISOString(),
  });
}

export async function exportWorkspaceAuditLog(
  workspaceId: string,
  format: AuditExportFormat,
  options: WorkspaceAuditLogOptions = {},
) {
  const sorted = filterAuditItems(await collectWorkspaceAuditItems(workspaceId), options);
  return serializeAuditExport(sorted, workspaceId, format, options);
}
