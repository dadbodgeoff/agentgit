import "server-only";

import { withControlPlaneState } from "@/lib/backend/control-plane/state";
import { AuditLogResponseSchema, type AuditEntry } from "@/schemas/cloud";
import { listWorkspaceApprovals, listWorkspaceRunContexts } from "@/lib/backend/workspace/workspace-runtime";

function repoLabel(owner: string, name: string) {
  return `${owner}/${name}`;
}

export function listWorkspaceAuditLog(workspaceId: string) {
  const items: AuditEntry[] = [];

  for (const { repository, approval } of listWorkspaceApprovals(workspaceId)) {
    items.push({
      id: approval.approval_id,
      occurredAt: approval.resolved_at ?? approval.requested_at,
      actorLabel: approval.resolved_at ? "Workspace reviewer" : "AgentGit policy engine",
      actorType: approval.resolved_at ? "human" : "system",
      category: "approval",
      action: approval.resolved_at ? `approval_${approval.status}` : "approval_requested",
      target: approval.action_summary,
      outcome:
        approval.status === "approved"
          ? "success"
          : approval.status === "denied"
            ? "failure"
            : "info",
      repo: repoLabel(repository.inventory.owner, repository.inventory.name),
      runId: approval.run_id,
      actionId: approval.action_id,
      details: approval.primary_reason?.message ?? "Approval decision recorded in the governed journal.",
    });
  }

  for (const context of listWorkspaceRunContexts(workspaceId)) {
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
        details: command.lastMessage ?? `${command.command.type} is ${command.status}.`,
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

  const sorted = items.sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime());
  return AuditLogResponseSchema.parse({
    items: sorted.slice(0, 100),
    total: sorted.length,
    generatedAt: new Date().toISOString(),
  });
}
