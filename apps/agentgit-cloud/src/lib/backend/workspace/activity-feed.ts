import "server-only";

import { withControlPlaneState } from "@/lib/backend/control-plane/state";
import { actionDetailRoute, repositoryRoute, runDetailRoute } from "@/lib/navigation/routes";
import { ActivityFeedResponseSchema, type ActivityEvent } from "@/schemas/cloud";
import { listWorkspaceRunContexts } from "@/lib/backend/workspace/workspace-runtime";
import { paginateItems } from "@/lib/pagination/cursor";

function buildRepoLabel(owner: string, name: string) {
  return `${owner}/${name}`;
}

function describeConnectorCommand(command: {
  command: { type: string };
  status: string;
  lastMessage: string | null;
  nextAttemptAt?: string | null;
  result?: Record<string, unknown> | null;
}): string {
  if (
    command.result &&
    command.command.type === "open_pull_request" &&
    typeof command.result.pullRequestUrl === "string"
  ) {
    return `Pull request opened: ${command.result.pullRequestUrl}`;
  }

  if (command.result && command.command.type === "create_commit" && typeof command.result.commitSha === "string") {
    return `Commit created: ${command.result.commitSha.slice(0, 12)}.`;
  }

  if (command.result && command.command.type === "push_branch" && typeof command.result.branch === "string") {
    return `Branch ${command.result.branch} pushed to ${typeof command.result.remoteName === "string" ? command.result.remoteName : "origin"}.`;
  }

  if (command.result && command.command.type === "execute_restore" && typeof command.result.snapshotId === "string") {
    return command.status === "completed"
      ? `Snapshot ${command.result.snapshotId} restored through the local connector.`
      : `Snapshot ${command.result.snapshotId} restore requires follow-up.`;
  }

  if (command.nextAttemptAt) {
    return `${command.lastMessage ?? `${command.command.type} is ${command.status}.`} Retry scheduled for ${command.nextAttemptAt}.`;
  }

  return command.lastMessage ?? `${command.command.type} is ${command.status}.`;
}

function titleForConnectorCommand(command: {
  command: { type: string };
  status: string;
  result?: Record<string, unknown> | null;
}) {
  if (command.command.type === "open_pull_request" && command.status === "completed") {
    return "Pull request opened";
  }

  if (command.command.type === "create_commit" && command.status === "completed") {
    return "Commit created";
  }

  if (command.command.type === "push_branch" && command.status === "completed") {
    return "Branch pushed";
  }

  if (command.command.type === "execute_restore" && command.status === "completed") {
    return "Snapshot restored";
  }

  if (command.command.type === "execute_restore") {
    return "Restore command updated";
  }

  if (command.command.type === "open_pull_request") {
    return "Pull request command updated";
  }

  return "Connector command";
}

function toneForConnectorCommand(command: { status: string; nextAttemptAt?: string | null }) {
  if (command.status === "failed") {
    return "error" as const;
  }

  if (command.status === "expired" || command.nextAttemptAt) {
    return "warning" as const;
  }

  if (command.status === "acked" || command.status === "pending") {
    return "accent" as const;
  }

  return "neutral" as const;
}

function detailPathForConnectorCommand(command: {
  command: { repository: { owner: string; name: string } };
  result?: Record<string, unknown> | null;
}) {
  const owner = command.command.repository.owner;
  const name = command.command.repository.name;

  if (typeof command.result?.runId === "string" && typeof command.result?.actionId === "string") {
    return actionDetailRoute(owner, name, command.result.runId, command.result.actionId);
  }

  if (typeof command.result?.runId === "string") {
    return runDetailRoute(owner, name, command.result.runId);
  }

  return repositoryRoute(owner, name);
}

function externalUrlForConnectorCommand(command: { result?: Record<string, unknown> | null }) {
  return typeof command.result?.pullRequestUrl === "string" ? command.result.pullRequestUrl : undefined;
}

function mapRunEventToActivity(params: {
  owner: string;
  name: string;
  runId: string;
  event: { event_type: string; occurred_at: string; payload?: Record<string, unknown> };
}): ActivityEvent | null {
  const repoLabel = buildRepoLabel(params.owner, params.name);
  const actionId = typeof params.event.payload?.action_id === "string" ? params.event.payload.action_id : undefined;
  const detailPath = actionId
    ? actionDetailRoute(params.owner, params.name, params.runId, actionId)
    : runDetailRoute(params.owner, params.name, params.runId);

  switch (params.event.event_type) {
    case "approval.requested":
      return {
        id: `${params.runId}:${params.event.occurred_at}:approval-requested`,
        kind: "approval_requested",
        title: "Approval requested",
        message: `A governed action in ${repoLabel} requires human review.`,
        repo: repoLabel,
        actorLabel: "AgentGit policy engine",
        runId: params.runId,
        actionId,
        detailPath,
        createdAt: params.event.occurred_at,
        tone: "accent",
      };
    case "approval.resolved":
      return {
        id: `${params.runId}:${params.event.occurred_at}:approval-resolved`,
        kind: "approval_resolved",
        title: "Approval resolved",
        message: `An approval gate in ${repoLabel} was resolved.`,
        repo: repoLabel,
        actorLabel: "Workspace reviewer",
        runId: params.runId,
        actionId,
        detailPath,
        createdAt: params.event.occurred_at,
        tone: "warning",
      };
    case "execution.completed":
      return {
        id: `${params.runId}:${params.event.occurred_at}:execution-completed`,
        kind: "run_completed",
        title: "Run completed",
        message: `A governed execution completed in ${repoLabel}.`,
        repo: repoLabel,
        actorLabel: "AgentGit runtime",
        runId: params.runId,
        actionId,
        detailPath,
        createdAt: params.event.occurred_at,
        tone: "neutral",
      };
    case "execution.failed":
    case "execution.outcome_unknown":
      return {
        id: `${params.runId}:${params.event.occurred_at}:execution-failed`,
        kind: "run_failed",
        title: "Run failed",
        message: `A governed execution failed in ${repoLabel}.`,
        repo: repoLabel,
        actorLabel: "AgentGit runtime",
        runId: params.runId,
        actionId,
        detailPath,
        createdAt: params.event.occurred_at,
        tone: "error",
      };
    case "recovery.executed":
      return {
        id: `${params.runId}:${params.event.occurred_at}:recovery-executed`,
        kind: "snapshot_restored",
        title: "Recovery executed",
        message: `Snapshot recovery executed for ${repoLabel}.`,
        repo: repoLabel,
        actorLabel: "AgentGit recovery engine",
        runId: params.runId,
        actionId,
        detailPath,
        createdAt: params.event.occurred_at,
        tone: "warning",
      };
    case "policy.evaluated":
      return {
        id: `${params.runId}:${params.event.occurred_at}:policy-evaluated`,
        kind: "policy_changed",
        title: "Policy gate evaluated",
        message: `A policy decision was recorded for ${repoLabel}.`,
        repo: repoLabel,
        actorLabel: "AgentGit policy engine",
        runId: params.runId,
        actionId,
        detailPath,
        createdAt: params.event.occurred_at,
        tone: "neutral",
      };
    default:
      return null;
  }
}

export async function listWorkspaceActivity(
  workspaceId: string,
  params: { cursor?: string | null; limit: number } = { limit: 25 },
) {
  const items: ActivityEvent[] = [];

  for (const context of await listWorkspaceRunContexts(workspaceId)) {
    for (const event of context.events) {
      const mapped = mapRunEventToActivity({
        owner: context.repository.inventory.owner,
        name: context.repository.inventory.name,
        runId: context.run.run_id,
        event,
      });
      if (mapped) {
        items.push(mapped);
      }
    }
  }

  withControlPlaneState((store) => {
    for (const command of store.listCommands()) {
      if (command.command.workspaceId !== workspaceId) {
        continue;
      }

      items.push({
        id: command.command.commandId,
        kind: "connector_command",
        title: titleForConnectorCommand(command),
        message: describeConnectorCommand(command),
        repo: buildRepoLabel(command.command.repository.owner, command.command.repository.name),
        actorLabel: "AgentGit cloud connector",
        detailPath: detailPathForConnectorCommand(command),
        externalUrl: externalUrlForConnectorCommand(command),
        createdAt: command.updatedAt,
        tone: toneForConnectorCommand(command),
      });
    }
  });

  const sorted = items.sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  const page = paginateItems(sorted, params);
  return ActivityFeedResponseSchema.parse({
    ...page,
    generatedAt: new Date().toISOString(),
  });
}
