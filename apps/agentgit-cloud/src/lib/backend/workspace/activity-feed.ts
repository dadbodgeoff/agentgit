import "server-only";

import { withControlPlaneState } from "@/lib/backend/control-plane/state";
import { actionDetailRoute, runDetailRoute } from "@/lib/navigation/routes";
import { ActivityFeedResponseSchema, type ActivityEvent } from "@/schemas/cloud";
import { listWorkspaceRunContexts } from "@/lib/backend/workspace/workspace-runtime";

function buildRepoLabel(owner: string, name: string) {
  return `${owner}/${name}`;
}

function mapRunEventToActivity(params: {
  owner: string;
  name: string;
  runId: string;
  event: { event_type: string; occurred_at: string; payload?: Record<string, unknown> };
}): ActivityEvent | null {
  const repoLabel = buildRepoLabel(params.owner, params.name);
  const actionId = typeof params.event.payload?.action_id === "string" ? params.event.payload.action_id : undefined;
  const detailPath = actionId ? actionDetailRoute(params.owner, params.name, params.runId, actionId) : runDetailRoute(params.owner, params.name, params.runId);

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

export function listWorkspaceActivity(workspaceId: string) {
  const items: ActivityEvent[] = [];

  for (const context of listWorkspaceRunContexts(workspaceId)) {
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
        title: "Connector command",
        message: command.lastMessage ?? `${command.command.type} is ${command.status}.`,
        repo: buildRepoLabel(command.command.repository.owner, command.command.repository.name),
        actorLabel: "AgentGit cloud connector",
        detailPath: undefined,
        createdAt: command.updatedAt,
        tone:
          command.status === "failed"
            ? "error"
            : command.status === "expired"
              ? "warning"
              : command.status === "completed"
                ? "neutral"
                : "accent",
      });
    }
  });

  const sorted = items.sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  return ActivityFeedResponseSchema.parse({
    items: sorted.slice(0, 50),
    total: sorted.length,
    generatedAt: new Date().toISOString(),
  });
}
