import "server-only";

import { ApprovalInboxItemSchema, type ApprovalInboxItem } from "@agentgit/schemas";
import { ResolveApprovalCommandPayloadSchema, type ConnectorCommandStatus } from "@agentgit/cloud-sync-protocol";

import { getRepositoryConnectorAvailability } from "@/lib/backend/control-plane/connectors";
import { withControlPlaneState } from "@/lib/backend/control-plane/state";
import { getStoredWorkspaceSettings } from "@/lib/backend/workspace/cloud-state";
import { ApprovalListResponseSchema, type ApprovalListItem } from "@/schemas/cloud";

type ApprovalRepositoryContext = {
  repositoryOwner: string;
  repositoryName: string;
};

export type WorkspaceApprovalProjection = ApprovalListItem &
  ApprovalRepositoryContext & {
    commandId: string | null;
  };

const DEFAULT_APPROVAL_TTL_MINUTES = 30;
const EXPIRING_SOON_WINDOW_MINUTES = 10;

function mapApprovalStatus(status: "pending" | "approved" | "denied"): ApprovalListItem["status"] {
  return status === "denied" ? "rejected" : status;
}

function mapApprovalDomain(domain: string): ApprovalListItem["domain"] {
  switch (domain) {
    case "shell":
    case "git":
    case "filesystem":
    case "network":
    case "deploy":
    case "policy":
      return domain;
    default:
      return "policy";
  }
}

function mapApprovalInboxItem(
  item: ApprovalInboxItem,
  repository: ApprovalRepositoryContext,
): WorkspaceApprovalProjection {
  return {
    id: item.approval_id,
    runId: item.run_id,
    actionId: item.action_id,
    repositoryOwner: repository.repositoryOwner,
    repositoryName: repository.repositoryName,
    workflowName: item.workflow_name,
    domain: mapApprovalDomain(item.action_domain),
    sideEffectLevel: item.side_effect_level,
    status: mapApprovalStatus(item.status),
    requestedAt: item.requested_at,
    resolvedAt: item.resolved_at ?? undefined,
    resolutionNote: item.resolution_note ?? undefined,
    expiresAt: undefined,
    expiresSoon: false,
    actionSummary: item.action_summary,
    reasonSummary: item.reason_summary,
    targetLocator: item.target_locator,
    targetLabel: item.target_label ?? undefined,
    snapshotRequired: item.snapshot_required,
    connectorStatus: "missing",
    connectorStatusReason: null,
    decisionCommandStatus: null,
    decisionCommandUpdatedAt: null,
    decisionCommandNextAttemptAt: null,
    decisionCommandMessage: null,
    commandId: null,
  };
}

function pickLatestByTimestamp<T extends { updatedAt: string }>(current: T | null, candidate: T): T {
  if (!current) {
    return candidate;
  }

  if (new Date(candidate.updatedAt).getTime() >= new Date(current.updatedAt).getTime()) {
    return candidate;
  }

  return current;
}

function futureMinutesTimestamp(occurredAt: string, minutes: number): string {
  return new Date(new Date(occurredAt).getTime() + minutes * 60 * 1000).toISOString();
}

function resolveApprovalDecisionStatus(status: ApprovalListItem["status"]): "approved" | "rejected" | "expired" {
  if (status === "approved") {
    return "approved";
  }

  if (status === "expired") {
    return "expired";
  }

  return "rejected";
}

export async function listWorkspaceApprovalProjections(workspaceId: string): Promise<WorkspaceApprovalProjection[]> {
  const settings = await getStoredWorkspaceSettings(workspaceId);
  const approvalTtlMinutes = settings?.approvalTtlMinutes ?? DEFAULT_APPROVAL_TTL_MINUTES;
  const referenceAt = new Date().toISOString();
  const approvals = withControlPlaneState((store) => {
    const projected = new Map<string, WorkspaceApprovalProjection>();

    for (const record of store
      .listEvents()
      .filter(
        (event) =>
          event.event.workspaceId === workspaceId &&
          (event.event.type === "approval.requested" || event.event.type === "approval.resolution"),
      )
      .sort((left, right) => {
        const timeDelta = new Date(left.event.occurredAt).getTime() - new Date(right.event.occurredAt).getTime();
        if (timeDelta !== 0) {
          return timeDelta;
        }

        return left.event.sequence - right.event.sequence;
      })) {
      const parsed = ApprovalInboxItemSchema.safeParse(record.event.payload);
      if (!parsed.success) {
        continue;
      }

      projected.set(
        parsed.data.approval_id,
        mapApprovalInboxItem(parsed.data, {
          repositoryOwner: record.event.repository.owner,
          repositoryName: record.event.repository.name,
        }),
      );
    }

    const latestCommands = new Map<
      string,
      {
        commandId: string;
        commandStatus: ConnectorCommandStatus;
        updatedAt: string;
        acknowledgedAt: string | null;
        resolution: "approved" | "denied";
        note?: string;
        message: string | null;
        nextAttemptAt: string | null;
      }
    >();

    for (const command of store
      .listCommands()
      .filter((record) => record.command.workspaceId === workspaceId && record.command.type === "resolve_approval")) {
      const parsedPayload = ResolveApprovalCommandPayloadSchema.safeParse(command.command.payload);
      if (!parsedPayload.success) {
        continue;
      }

      latestCommands.set(
        parsedPayload.data.approvalId,
        pickLatestByTimestamp(latestCommands.get(parsedPayload.data.approvalId) ?? null, {
          commandId: command.command.commandId,
          commandStatus: command.status,
          updatedAt: command.updatedAt,
          acknowledgedAt: command.acknowledgedAt,
          resolution: parsedPayload.data.resolution,
          note: parsedPayload.data.note,
          message: command.lastMessage,
          nextAttemptAt: command.nextAttemptAt,
        }),
      );
    }

    for (const approval of projected.values()) {
      const command = latestCommands.get(approval.id);
      approval.expiresAt = futureMinutesTimestamp(approval.requestedAt, approvalTtlMinutes);

      if (command) {
        approval.commandId = command.commandId;
        approval.decisionCommandStatus = command.commandStatus;
        approval.decisionCommandUpdatedAt = command.updatedAt;
        approval.decisionCommandNextAttemptAt = command.nextAttemptAt;
        approval.decisionCommandMessage = command.message;

        if (command.commandStatus === "pending" || command.commandStatus === "acked" || command.commandStatus === "completed") {
          approval.status = command.resolution === "approved" ? "approved" : "rejected";
          approval.resolvedAt = command.acknowledgedAt ?? command.updatedAt;
          approval.resolutionNote = command.note ?? approval.resolutionNote;
        }
      }

      if (approval.status === "pending" && new Date(approval.expiresAt).getTime() <= new Date(referenceAt).getTime()) {
        approval.status = "expired";
        approval.resolvedAt = approval.expiresAt;
        approval.resolutionNote = approval.resolutionNote ?? "Approval timed out before a reviewer decision was delivered.";
      }

      const expiresSoonMs = EXPIRING_SOON_WINDOW_MINUTES * 60 * 1000;
      approval.expiresSoon =
        approval.status === "pending" &&
        new Date(approval.expiresAt).getTime() - new Date(referenceAt).getTime() <= expiresSoonMs;
    }

    return Array.from(projected.values());
  });

  for (const approval of approvals) {
    const connectorAvailability = getRepositoryConnectorAvailability(
      workspaceId,
      approval.repositoryOwner,
      approval.repositoryName,
      undefined,
      referenceAt,
    );

    approval.connectorStatus = connectorAvailability.status;
    approval.connectorStatusReason = connectorAvailability.reason;
    if (
      approval.status !== "pending" &&
      approval.decisionCommandStatus !== null &&
      (approval.decisionCommandStatus === "failed" || approval.decisionCommandStatus === "expired") &&
      !approval.decisionCommandMessage
    ) {
      approval.decisionCommandMessage =
        approval.decisionCommandStatus === "failed"
          ? "Connector delivery failed before the local daemon confirmed the decision."
          : "Connector delivery expired before the local daemon confirmed the decision.";
    }
  }

  approvals.sort((left, right) => {
    if (left.status !== right.status) {
      if (left.status === "pending") {
        return -1;
      }
      if (right.status === "pending") {
        return 1;
      }
    }

    const leftTimestamp = left.status === "pending" ? left.requestedAt : left.resolvedAt ?? left.requestedAt;
    const rightTimestamp = right.status === "pending" ? right.requestedAt : right.resolvedAt ?? right.requestedAt;
    return new Date(rightTimestamp).getTime() - new Date(leftTimestamp).getTime();
  });

  return approvals;
}

export async function getWorkspaceApprovalProjection(
  workspaceId: string,
  approvalId: string,
): Promise<WorkspaceApprovalProjection | null> {
  return (await listWorkspaceApprovalProjections(workspaceId)).find((approval) => approval.id === approvalId) ?? null;
}

export async function listWorkspaceApprovalQueue(workspaceId: string) {
  const items = (await listWorkspaceApprovalProjections(workspaceId)).map(({ commandId: _commandId, ...approval }) => approval);

  return ApprovalListResponseSchema.parse({
    items,
    total: items.length,
    page: 1,
    per_page: items.length === 0 ? 25 : items.length,
    has_more: false,
  });
}
