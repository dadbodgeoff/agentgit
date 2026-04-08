import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { ConnectorTokenRecord, ControlPlaneStateStore } from "@agentgit/control-plane-state";
import { createCommandAckResponse, createHeartbeatRecord } from "@agentgit/control-plane-state";
import { ApprovalInboxItemSchema } from "@agentgit/schemas";
import {
  CreateCommitCommandPayloadSchema,
  OpenPullRequestCommandPayloadSchema,
  ReplayRunCommandPayloadSchema,
  ResolveApprovalCommandPayloadSchema,
  RestoreCommandPayloadSchema,
  PushBranchCommandPayloadSchema,
  RefreshRepoStateCommandPayloadSchema,
  SyncRunHistoryCommandPayloadSchema,
  ConnectorCommandPullResponseSchema,
  ConnectorEventBatchResponseSchema,
  ConnectorHeartbeatResponseSchema,
  ConnectorRegistrationResponseSchema,
  type ConnectorCommandAckRequest,
  type ConnectorCommandType,
  type ConnectorCommandPullRequest,
  type ConnectorEventBatchRequest,
  type ConnectorHeartbeatRequest,
  type ConnectorRecord,
  type ConnectorRegistrationRequest,
} from "@agentgit/cloud-sync-protocol";

import { withControlPlaneState } from "@/lib/backend/control-plane/state";
import { resolveProviderRepositoryIdentity } from "@/lib/backend/providers/repository-identity";
import {
  notifyWorkspaceApprovalRequested,
  notifyWorkspacePolicyChanged,
  notifyWorkspaceRunFailed,
  notifyWorkspaceSnapshotRestored,
} from "@/lib/backend/workspace/workspace-integrations";
import { actionDetailRoute, repositoryRoute, repositorySnapshotsRoute, runDetailRoute } from "@/lib/navigation/routes";
import {
  ConnectorBootstrapResponseSchema,
  ConnectorCommandRetryResponseSchema,
  ConnectorRevokeResponseSchema,
  WorkspaceConnectorInventorySchema,
  type CursorPaginationQuery,
  type ConnectorCommandDispatchRequest,
} from "@/schemas/cloud";
import type { WorkspaceSession } from "@/schemas/cloud";
import { paginateItems } from "@/lib/pagination/cursor";

export class ConnectorAccessError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "ConnectorAccessError";
  }
}

export type ConnectorAccessContext = {
  connector: ConnectorRecord;
  token: ConnectorTokenRecord;
};

export type RepositoryConnectorAvailability = {
  status: "active" | "stale" | "revoked" | "missing";
  reason: string | null;
  connectorId: string | null;
  machineName: string | null;
  lastSeenAt: string | null;
  daemonReachable: boolean | null;
};

export function hashConnectorToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

function createConnectorAccessToken(): string {
  return `agcs_${randomBytes(24).toString("base64url")}`;
}

function createConnectorBootstrapToken(): string {
  return `agcbt_${randomBytes(24).toString("base64url")}`;
}

function futureTimestamp(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function futureMinutesTimestamp(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

const COMMAND_LEASE_MINUTES = 5;
const CONNECTOR_STALE_MINUTES = 10;
const AUTOMATIC_RETRY_DELAYS_MINUTES = [1, 5, 15] as const;
const AUTOMATIC_RETRY_COMMAND_TYPES = new Set<ConnectorCommandType>(["refresh_repo_state", "sync_run_history"]);

function normalizeWorkspacePath(candidate: string): string {
  const resolved = path.resolve(candidate);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function sameWorkspaceRoot(left: string, right: string): boolean {
  return normalizeWorkspacePath(left) === normalizeWorkspacePath(right);
}

function normalizeCommandPayload(request: ConnectorCommandDispatchRequest): Record<string, unknown> {
  switch (request.type) {
    case "refresh_repo_state":
      return RefreshRepoStateCommandPayloadSchema.parse({
        forceFullSync: request.forceFullSync,
      });
    case "sync_run_history":
      return SyncRunHistoryCommandPayloadSchema.parse({
        includeSnapshots: request.includeSnapshots,
      });
    case "replay_run":
      return ReplayRunCommandPayloadSchema.parse({
        sourceRunId: request.sourceRunId,
        replayWorkflowName: request.replayWorkflowName,
      });
    case "resolve_approval":
      return ResolveApprovalCommandPayloadSchema.parse({
        approvalId: request.approvalId,
        resolution: request.resolution,
        note: request.note,
      });
    case "create_commit":
      return CreateCommitCommandPayloadSchema.parse({
        message: request.message,
        stageAll: request.stageAll,
        paths: request.paths,
      });
    case "push_branch":
      return PushBranchCommandPayloadSchema.parse({
        branch: request.branch,
        setUpstream: request.setUpstream,
      });
    case "execute_restore":
      return RestoreCommandPayloadSchema.parse({
        snapshotId: request.snapshotId,
      });
    case "open_pull_request":
      return OpenPullRequestCommandPayloadSchema.parse({
        title: request.title,
        body: request.body,
        baseBranch: request.baseBranch,
        headBranch: request.headBranch,
        draft: request.draft,
      });
    default:
      return {};
  }
}

function getConnectorStatusDetails(lastSeenAt: string, revoked: boolean, referenceAt: string) {
  if (revoked) {
    return {
      status: "revoked" as const,
      reason: "Connector access has been revoked from the control plane.",
    };
  }

  const ageMs = new Date(referenceAt).getTime() - new Date(lastSeenAt).getTime();
  const staleMs = CONNECTOR_STALE_MINUTES * 60 * 1000;
  if (ageMs >= staleMs) {
    return {
      status: "stale" as const,
      reason: `No heartbeat seen for more than ${CONNECTOR_STALE_MINUTES} minutes.`,
    };
  }

  return {
    status: "active" as const,
    reason: null,
  };
}

function getLatestConnectorToken(store: ControlPlaneStateStore, connectorId: string) {
  return (
    store
      .listConnectorTokens(connectorId)
      .sort((left, right) => new Date(right.issuedAt).getTime() - new Date(left.issuedAt).getTime())[0] ?? null
  );
}

function getLatestTimestamp(values: Array<string | null | undefined>): string | null {
  return values.reduce<string | null>((latest, value) => {
    if (!value) {
      return latest;
    }

    if (!latest) {
      return value;
    }

    return new Date(value).getTime() > new Date(latest).getTime() ? value : latest;
  }, null);
}

function getConnectorDispatchHealth(store: ControlPlaneStateStore, connector: ConnectorRecord, referenceAt: string) {
  const latestToken = getLatestConnectorToken(store, connector.id);
  const statusDetails = getConnectorStatusDetails(
    connector.lastSeenAt,
    connector.status === "revoked" || Boolean(latestToken?.revokedAt),
    referenceAt,
  );

  return {
    latestToken,
    status: statusDetails.status,
    reason:
      statusDetails.reason ??
      (latestToken === null ? "Connector has no active access token and cannot receive commands." : null),
    dispatchable: statusDetails.status === "active" && latestToken !== null,
  };
}

function getLatestConnectorActivityAt(store: ControlPlaneStateStore, connectorId: string, fallback: string) {
  const latestCommandAt = getLatestTimestamp(store.listCommands(connectorId).map((command) => command.updatedAt));
  const latestEventAt = getLatestTimestamp(store.listEvents(connectorId).map((event) => event.ingestedAt));
  return getLatestTimestamp([latestCommandAt, latestEventAt, fallback]) ?? fallback;
}

function getAutomaticRetryDelayMinutes(attemptCount: number): number | null {
  return AUTOMATIC_RETRY_DELAYS_MINUTES[attemptCount - 1] ?? null;
}

function supportsAutomaticRetry(commandType: ConnectorCommandType): boolean {
  return AUTOMATIC_RETRY_COMMAND_TYPES.has(commandType);
}

function getCommandReplayStatus(command: {
  status: "pending" | "acked" | "completed" | "failed" | "expired";
  nextAttemptAt: string | null;
  leaseExpiresAt: string | null;
  referenceAt: string;
}) {
  const leaseExpired =
    command.leaseExpiresAt !== null &&
    new Date(command.leaseExpiresAt).getTime() <= new Date(command.referenceAt).getTime();

  if (command.status === "failed" || command.status === "expired") {
    return {
      replayable: true,
      replayStatus: command.nextAttemptAt ? "scheduled" : "available",
      replayReason:
        command.status === "failed"
          ? "Replay is safe because the command failed before a durable result was recorded."
          : "Replay is safe because the command expired before execution finished.",
    } as const;
  }

  if (command.status === "acked") {
    if (leaseExpired) {
      return {
        replayable: true,
        replayStatus: "available",
        replayReason: "Connector lease expired before completion. The command can be reclaimed safely.",
      } as const;
    }

    return {
      replayable: false,
      replayStatus: "leased",
      replayReason: "Command is still leased to a connector.",
    } as const;
  }

  if (command.status === "pending") {
    if (leaseExpired) {
      return {
        replayable: true,
        replayStatus: "available",
        replayReason: "Pending command lease expired before completion. The command can be reclaimed safely.",
      } as const;
    }

    return {
      replayable: false,
      replayStatus: "queued",
      replayReason: "Command is still waiting in the pending queue.",
    } as const;
  }

  return {
    replayable: false,
    replayStatus: "settled",
    replayReason: "Command already completed successfully and does not need replay.",
  } as const;
}

function getCommandDetailPath(command: {
  command: {
    repository: { owner: string; name: string };
    type: ConnectorCommandType;
  };
  result: Record<string, unknown> | null;
}) {
  const owner = command.command.repository.owner;
  const name = command.command.repository.name;

  if (command.command.type === "execute_restore" || command.command.type === "resolve_approval") {
    if (typeof command.result?.runId === "string" && typeof command.result?.actionId === "string") {
      return actionDetailRoute(owner, name, command.result.runId, command.result.actionId);
    }

    if (typeof command.result?.runId === "string") {
      return runDetailRoute(owner, name, command.result.runId);
    }

    return repositorySnapshotsRoute(owner, name);
  }

  return repositoryRoute(owner, name);
}

function getCommandExternalUrl(command: {
  command: { type: ConnectorCommandType };
  result: Record<string, unknown> | null;
}) {
  if (command.command.type === "open_pull_request" && typeof command.result?.pullRequestUrl === "string") {
    return command.result.pullRequestUrl;
  }

  return null;
}

export function issueConnectorBootstrapToken(
  workspaceSession: WorkspaceSession,
  cloudBaseUrl: string,
  issuedAt: string,
) {
  const bootstrapToken = createConnectorBootstrapToken();
  const tokenHash = hashConnectorToken(bootstrapToken);
  const expiresAt = futureMinutesTimestamp(30);

  withControlPlaneState((store) => {
    store.putConnectorBootstrapToken({
      tokenHash,
      workspaceId: workspaceSession.activeWorkspace.id,
      workspaceSlug: workspaceSession.activeWorkspace.slug,
      issuedByUserId: workspaceSession.user.id,
      issuedAt,
      expiresAt,
      consumedAt: null,
      revokedAt: null,
    });
  });

  const commandHint = [
    "agentgit-cloud-connector bootstrap",
    `--cloud-url ${cloudBaseUrl}`,
    `--workspace-id ${workspaceSession.activeWorkspace.id}`,
    `--workspace-root ${JSON.stringify(process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS?.split(",")[0] ?? process.cwd())}`,
    `--bootstrap-token ${bootstrapToken}`,
    "&&",
    "agentgit-cloud-connector run",
    `--workspace-root ${JSON.stringify(process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS?.split(",")[0] ?? process.cwd())}`,
  ].join(" ");

  return ConnectorBootstrapResponseSchema.parse({
    bootstrapToken,
    workspaceId: workspaceSession.activeWorkspace.id,
    workspaceSlug: workspaceSession.activeWorkspace.slug,
    expiresAt,
    commandHint,
  });
}

function consumeConnectorBootstrapToken(rawToken: string, consumedAt: string) {
  const tokenHash = hashConnectorToken(rawToken);

  return withControlPlaneState((store) => {
    const token = store.getConnectorBootstrapToken(tokenHash);
    if (!token) {
      throw new ConnectorAccessError("Connector bootstrap token is invalid.", 401);
    }

    if (token.revokedAt) {
      throw new ConnectorAccessError("Connector bootstrap token has been revoked.", 401);
    }

    if (token.consumedAt) {
      throw new ConnectorAccessError("Connector bootstrap token has already been used.", 401);
    }

    if (new Date(token.expiresAt).getTime() <= Date.now()) {
      throw new ConnectorAccessError("Connector bootstrap token has expired.", 401);
    }

    const next = {
      ...token,
      consumedAt,
    };
    store.putConnectorBootstrapToken(next);
    return next;
  });
}

export function registerConnector(
  input: ConnectorRegistrationRequest,
  workspace: Pick<WorkspaceSession["activeWorkspace"], "id" | "slug">,
  registeredAt: string,
) {
  const connectorId = `conn_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const accessToken = createConnectorAccessToken();
  const connector = {
    id: connectorId,
    workspaceId: workspace.id,
    workspaceSlug: workspace.slug,
    connectorName: input.connectorName,
    machineName: input.machineName,
    connectorVersion: input.connectorVersion,
    platform: input.platform,
    capabilities: input.capabilities,
    repository: input.repository,
    status: "active" as const,
    registeredAt,
    lastSeenAt: registeredAt,
  };
  const tokenRecord: ConnectorTokenRecord = {
    tokenHash: hashConnectorToken(accessToken),
    connectorId,
    workspaceId: workspace.id,
    issuedAt: registeredAt,
    expiresAt: futureTimestamp(30),
    revokedAt: null,
  };

  withControlPlaneState((store) => {
    store.putConnector(connector);
    store.putConnectorToken(tokenRecord);
  });

  return ConnectorRegistrationResponseSchema.parse({
    schemaVersion: "cloud-sync.v1",
    connector,
    accessToken,
    issuedAt: tokenRecord.issuedAt,
    expiresAt: tokenRecord.expiresAt,
  });
}

export function getConnectorAccessByToken(rawToken: string): ConnectorAccessContext {
  const tokenHash = hashConnectorToken(rawToken);

  return withControlPlaneState((store) => {
    const token = store.getConnectorToken(tokenHash);
    if (!token) {
      throw new ConnectorAccessError("Connector access token is invalid.", 401);
    }

    if (token.revokedAt) {
      throw new ConnectorAccessError("Connector access token has been revoked.", 401);
    }

    if (new Date(token.expiresAt).getTime() <= Date.now()) {
      throw new ConnectorAccessError("Connector access token has expired.", 401);
    }

    const connector = store.getConnector(token.connectorId);
    if (!connector) {
      throw new ConnectorAccessError("Connector record was not found.", 401);
    }

    return {
      connector,
      token,
    };
  });
}

export function registerConnectorWithBootstrapToken(
  input: ConnectorRegistrationRequest,
  bootstrapToken: string,
  registeredAt: string,
) {
  const bootstrap = consumeConnectorBootstrapToken(bootstrapToken, registeredAt);
  if (input.workspaceId !== bootstrap.workspaceId) {
    throw new ConnectorAccessError("Connector registration workspace scope did not match the bootstrap token.", 403);
  }
  return registerConnector(
    input,
    {
      id: bootstrap.workspaceId,
      slug: bootstrap.workspaceSlug,
    },
    registeredAt,
  );
}

export function recordConnectorHeartbeat(
  access: ConnectorAccessContext,
  heartbeat: ConnectorHeartbeatRequest,
  acceptedAt: string,
) {
  if (heartbeat.connectorId !== access.connector.id) {
    throw new ConnectorAccessError("Heartbeat connector id did not match the access token.", 403);
  }

  return withControlPlaneState((store) => {
    store.putHeartbeat(
      createHeartbeatRecord({
        workspaceId: access.connector.workspaceId,
        receivedAt: acceptedAt,
        heartbeat,
      }),
    );
    store.putConnector({
      ...access.connector,
      repository: heartbeat.repository,
      lastSeenAt: acceptedAt,
      status: "active",
    });

    const pendingCommandCount = store
      .listCommands(access.connector.id)
      .filter((command) => command.status === "pending" || command.status === "acked").length;
    return ConnectorHeartbeatResponseSchema.parse({
      schemaVersion: "cloud-sync.v1",
      connectorId: access.connector.id,
      acceptedAt,
      status: "active",
      pendingCommandCount,
    });
  });
}

export async function ingestConnectorEvents(
  access: ConnectorAccessContext,
  batch: ConnectorEventBatchRequest,
  acceptedAt: string,
) {
  if (batch.connectorId !== access.connector.id) {
    throw new ConnectorAccessError("Event batch connector id did not match the access token.", 403);
  }

  for (const event of batch.events) {
    if (event.connectorId !== access.connector.id || event.workspaceId !== access.connector.workspaceId) {
      throw new ConnectorAccessError("Event batch contains records outside the connector workspace scope.", 403);
    }
  }

  const { response, approvalRequests, notifications } = withControlPlaneState((store) => {
    const existingEventIds = new Set(store.listEvents(access.connector.id).map((event) => event.event.eventId));
    const approvalRequests: Array<{
      repositoryOwner: string;
      repositoryName: string;
      approval: import("@agentgit/schemas").ApprovalInboxItem;
    }> = [];
    const notifications: Array<Promise<void>> = [];

    for (const event of batch.events) {
      store.appendEvent({
        event,
        ingestedAt: acceptedAt,
      });

      if (!existingEventIds.has(event.eventId) && event.type === "approval.requested") {
        const parsedApproval = ApprovalInboxItemSchema.safeParse(event.payload);
        if (parsedApproval.success) {
          approvalRequests.push({
            repositoryOwner: event.repository.owner,
            repositoryName: event.repository.name,
            approval: parsedApproval.data,
          });
        }
      }

      if (!existingEventIds.has(event.eventId) && event.type === "policy.state") {
        notifications.push(
          notifyWorkspacePolicyChanged({
            workspaceId: access.connector.workspaceId,
            workspaceSlug: access.connector.workspaceSlug,
            repositoryOwner: event.repository.owner,
            repositoryName: event.repository.name,
            kind: typeof event.payload.kind === "string" ? event.payload.kind : "workspace_policy",
            digest: typeof event.payload.digest === "string" ? event.payload.digest : null,
          }),
        );
      }

      if (!existingEventIds.has(event.eventId) && event.type === "run.event") {
        const runId = typeof event.payload.runId === "string" ? event.payload.runId : null;
        const runEvent =
          typeof event.payload.event === "object" && event.payload.event !== null ? event.payload.event : null;
        const eventType =
          typeof (runEvent as { event_type?: unknown } | null)?.event_type === "string"
            ? (runEvent as { event_type: string }).event_type
            : null;
        const eventPayload =
          typeof (runEvent as { payload?: unknown } | null)?.payload === "object" &&
          (runEvent as { payload?: unknown }).payload !== null
            ? (runEvent as { payload: Record<string, unknown> }).payload
            : null;
        const actionId = typeof eventPayload?.action_id === "string" ? eventPayload.action_id : null;

        if (eventType === "execution.failed" && runId) {
          notifications.push(
            notifyWorkspaceRunFailed({
              workspaceId: access.connector.workspaceId,
              workspaceSlug: access.connector.workspaceSlug,
              repositoryOwner: event.repository.owner,
              repositoryName: event.repository.name,
              runId,
              actionId,
            }),
          );
        }

        if (
          eventType === "recovery.executed" &&
          runId &&
          (eventPayload?.strategy === "restore_snapshot" || eventPayload?.outcome === "restored")
        ) {
          notifications.push(
            notifyWorkspaceSnapshotRestored({
              workspaceId: access.connector.workspaceId,
              workspaceSlug: access.connector.workspaceSlug,
              repositoryOwner: event.repository.owner,
              repositoryName: event.repository.name,
              runId,
              snapshotId: typeof eventPayload?.snapshot_id === "string" ? eventPayload.snapshot_id : null,
            }),
          );
        }
      }
    }

    store.putConnector({
      ...access.connector,
      lastSeenAt: acceptedAt,
      status: "active",
    });

    const highestAcceptedSequence = batch.events.reduce((highest, event) => Math.max(highest, event.sequence), 0);
    return {
      response: ConnectorEventBatchResponseSchema.parse({
        schemaVersion: "cloud-sync.v1",
        connectorId: access.connector.id,
        acceptedAt,
        acceptedCount: batch.events.length,
        highestAcceptedSequence,
      }),
      approvalRequests,
      notifications,
    };
  });

  await Promise.allSettled([
    ...approvalRequests.map((request) =>
      notifyWorkspaceApprovalRequested({
        workspaceId: access.connector.workspaceId,
        workspaceSlug: access.connector.workspaceSlug,
        repositoryOwner: request.repositoryOwner,
        repositoryName: request.repositoryName,
        approval: request.approval,
      }),
    ),
    ...notifications,
  ]);

  return response;
}

export function pullPendingConnectorCommands(
  access: ConnectorAccessContext,
  request: ConnectorCommandPullRequest,
  acceptedAt: string,
) {
  if (request.connectorId !== access.connector.id) {
    throw new ConnectorAccessError("Command pull connector id did not match the access token.", 403);
  }

  return withControlPlaneState((store) => {
    store.putConnector({
      ...access.connector,
      lastSeenAt: acceptedAt,
      status: "active",
    });

    const leaseExpiresAt = futureMinutesTimestamp(COMMAND_LEASE_MINUTES);
    return ConnectorCommandPullResponseSchema.parse({
      schemaVersion: "cloud-sync.v1",
      connectorId: access.connector.id,
      commands: store
        .claimDispatchableCommands({
          connectorId: access.connector.id,
          claimedAt: acceptedAt,
          leaseExpiresAt,
        })
        .map((row) => row.command),
      acceptedAt,
    });
  });
}

export function acknowledgeConnectorCommand(
  access: ConnectorAccessContext,
  request: ConnectorCommandAckRequest,
  acceptedAt: string,
) {
  if (request.connectorId !== access.connector.id) {
    throw new ConnectorAccessError("Command acknowledgement connector id did not match the access token.", 403);
  }

  return withControlPlaneState((store) => {
    const command = store.getCommand(request.commandId);
    if (!command) {
      throw new ConnectorAccessError("Connector command was not found.", 404);
    }

    if (
      command.command.connectorId !== access.connector.id ||
      command.command.workspaceId !== access.connector.workspaceId
    ) {
      throw new ConnectorAccessError("Connector command is outside the connector workspace scope.", 403);
    }

    const updatedCommand = store.updateCommandStatus({
      commandId: request.commandId,
      status: request.status,
      updatedAt: acceptedAt,
      acknowledgedAt: request.status === "acked" || request.status === "completed" ? request.acknowledgedAt : null,
      leaseExpiresAt: request.status === "acked" ? futureMinutesTimestamp(COMMAND_LEASE_MINUTES) : null,
      nextAttemptAt: null,
      lastMessage: request.message ?? null,
      result: request.result ?? null,
    });
    if (!updatedCommand) {
      throw new ConnectorAccessError("Connector command was not found.", 404);
    }

    if (request.status === "failed" && supportsAutomaticRetry(updatedCommand.command.type)) {
      const retryDelayMinutes = getAutomaticRetryDelayMinutes(updatedCommand.attemptCount);
      if (retryDelayMinutes !== null) {
        const nextAttemptAt = futureMinutesTimestamp(retryDelayMinutes);
        store.scheduleCommandRetry({
          commandId: request.commandId,
          scheduledAt: acceptedAt,
          nextAttemptAt,
          expiresAt: futureTimestamp(1),
          message: `${request.message ?? `${updatedCommand.command.type} failed.`} Automatic retry scheduled for ${nextAttemptAt}.`,
        });
      }
    }

    store.putConnector({
      ...access.connector,
      lastSeenAt: acceptedAt,
      status: "active",
    });

    return createCommandAckResponse({
      commandId: request.commandId,
      connectorId: access.connector.id,
      acceptedAt,
      status: request.status,
    });
  });
}

export async function listWorkspaceConnectors(
  workspaceId: string,
  generatedAt: string,
  params: CursorPaginationQuery = { limit: 25 },
) {
  const connectorRecords = withControlPlaneState((store) =>
    store.listConnectors(workspaceId).map((connector) => {
      const token =
        store
          .listConnectorTokens(connector.id)
          .sort((left, right) => new Date(right.issuedAt).getTime() - new Date(left.issuedAt).getTime())[0] ?? null;
      const heartbeat = store.getHeartbeat(connector.id);
      const commands = store
        .listCommands(connector.id)
        .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
      const events = store
        .listEvents(connector.id)
        .sort((left, right) => new Date(right.event.occurredAt).getTime() - new Date(left.event.occurredAt).getTime());
      const lastCommand = commands[0] ?? null;
      const lastEvent = events[0] ?? null;
      const pendingCommandCount = commands.filter(
        (command) => command.status === "pending" || command.status === "acked",
      ).length;
      const leasedCommandCount = commands.filter(
        (command) =>
          command.status === "acked" &&
          command.leaseExpiresAt !== null &&
          new Date(command.leaseExpiresAt).getTime() > new Date(generatedAt).getTime(),
      ).length;
      const retryableCommandCount = commands.filter(
        (command) => command.status === "failed" || command.status === "expired",
      ).length;
      const automaticRetryCount = commands.filter((command) => command.nextAttemptAt !== null).length;
      const statusDetails = getConnectorStatusDetails(connector.lastSeenAt, Boolean(token?.revokedAt), generatedAt);

      return {
        connector,
        id: connector.id,
        connectorName: connector.connectorName,
        machineName: connector.machineName,
        status: statusDetails.status,
        connectorVersion: connector.connectorVersion,
        registeredAt: connector.registeredAt,
        lastSeenAt: connector.lastSeenAt,
        workspaceSlug: connector.workspaceSlug,
        capabilities: connector.capabilities,
        repositoryOwner: connector.repository.repo.owner,
        repositoryName: connector.repository.repo.name,
        currentBranch: connector.repository.currentBranch,
        headSha: connector.repository.headSha,
        isDirty: connector.repository.isDirty,
        aheadBy: connector.repository.aheadBy,
        behindBy: connector.repository.behindBy,
        workspaceRoot: connector.repository.workspaceRoot,
        daemonReachable: heartbeat?.localDaemon.reachable ?? false,
        pendingCommandCount,
        leasedCommandCount,
        retryableCommandCount,
        automaticRetryCount,
        eventCount: events.length,
        lastEvent: lastEvent
          ? {
              eventId: lastEvent.event.eventId,
              type: lastEvent.event.type,
              occurredAt: lastEvent.event.occurredAt,
            }
          : null,
        statusReason: statusDetails.reason,
        revokedAt: token?.revokedAt ?? null,
        lastCommand: lastCommand
          ? {
              commandId: lastCommand.command.commandId,
              type: lastCommand.command.type,
              status: lastCommand.status,
              issuedAt: lastCommand.command.issuedAt,
              updatedAt: lastCommand.updatedAt,
              acknowledgedAt: lastCommand.acknowledgedAt,
              leaseExpiresAt: lastCommand.leaseExpiresAt,
              attemptCount: lastCommand.attemptCount,
              nextAttemptAt: lastCommand.nextAttemptAt,
              message: lastCommand.lastMessage,
              result: lastCommand.result,
            }
          : null,
        recentCommands: commands.slice(0, 8).map((command) => {
          const replay = getCommandReplayStatus({
            status: command.status,
            nextAttemptAt: command.nextAttemptAt,
            leaseExpiresAt: command.leaseExpiresAt,
            referenceAt: generatedAt,
          });

          return {
            commandId: command.command.commandId,
            type: command.command.type,
            status: command.status,
            issuedAt: command.command.issuedAt,
            updatedAt: command.updatedAt,
            acknowledgedAt: command.acknowledgedAt,
            leaseExpiresAt: command.leaseExpiresAt,
            attemptCount: command.attemptCount,
            nextAttemptAt: command.nextAttemptAt,
            message: command.lastMessage,
            result: command.result,
            detailPath: getCommandDetailPath(command),
            externalUrl: getCommandExternalUrl(command),
            replayable: replay.replayable,
            replayStatus: replay.replayStatus,
            replayReason: replay.replayReason,
          };
        }),
        recentEvents: events.slice(0, 5).map((event) => ({
          eventId: event.event.eventId,
          type: event.event.type,
          occurredAt: event.event.occurredAt,
        })),
      };
    }),
  );

  const items = await Promise.all(
    connectorRecords.map(async ({ connector, ...record }) => ({
      ...record,
      providerIdentity: await resolveProviderRepositoryIdentity({
        provider: connector.repository.provider,
        owner: connector.repository.repo.owner,
        name: connector.repository.repo.name,
        defaultBranch: connector.repository.defaultBranch,
      }),
    })),
  );

  const sortedItems = items.sort(
    (left, right) => new Date(right.lastSeenAt).getTime() - new Date(left.lastSeenAt).getTime(),
  );
  const page = paginateItems(sortedItems, params);

  return WorkspaceConnectorInventorySchema.parse({
    ...page,
    generatedAt,
  });
}

export function revokeWorkspaceConnector(workspaceId: string, connectorId: string, revokedAt: string) {
  return withControlPlaneState((store) => {
    const connector = store.getConnector(connectorId);
    if (!connector || connector.workspaceId !== workspaceId) {
      throw new ConnectorAccessError("Connector was not found for the active workspace.", 404);
    }

    store.revokeConnector(connectorId, revokedAt);

    return ConnectorRevokeResponseSchema.parse({
      connectorId,
      revokedAt,
      message: `Connector access for ${connector.machineName} has been revoked.`,
    });
  });
}

export function retryConnectorCommand(workspaceId: string, commandId: string, retriedAt: string) {
  return withControlPlaneState((store) => {
    const command = store.getCommand(commandId);
    if (!command || command.command.workspaceId !== workspaceId) {
      throw new ConnectorAccessError("Connector command was not found for the active workspace.", 404);
    }

    const leaseExpired =
      command.leaseExpiresAt !== null && new Date(command.leaseExpiresAt).getTime() <= new Date(retriedAt).getTime();
    const reclaimableLease = (command.status === "acked" || command.status === "pending") && leaseExpired;

    if (command.status !== "failed" && command.status !== "expired" && !reclaimableLease) {
      throw new ConnectorAccessError("Only failed, expired, or lease-expired commands can be replayed.", 409);
    }

    const retried = store.retryCommand(commandId, retriedAt, futureTimestamp(1));
    if (!retried) {
      throw new ConnectorAccessError("Connector command was not found for the active workspace.", 404);
    }

    return ConnectorCommandRetryResponseSchema.parse({
      commandId,
      connectorId: retried.command.connectorId,
      status: retried.status,
      queuedAt: retried.updatedAt,
      message:
        retried.status === "pending"
          ? reclaimableLease
            ? `${retried.command.type} lease expired and the command was reclaimed into the pending queue.`
            : `${retried.command.type} returned to the pending queue.`
          : `Command ${retried.command.type} is not retryable from its current state.`,
    });
  });
}

export function queueConnectorCommand(
  workspaceSession: WorkspaceSession,
  connectorId: string,
  request: ConnectorCommandDispatchRequest,
  queuedAt: string,
) {
  return withControlPlaneState((store) => {
    const connector = store.getConnector(connectorId);
    if (!connector || connector.workspaceId !== workspaceSession.activeWorkspace.id) {
      throw new ConnectorAccessError("Connector was not found for the active workspace.", 404);
    }

    const health = getConnectorDispatchHealth(store, connector, queuedAt);
    if (!health.dispatchable) {
      throw new ConnectorAccessError(
        health.reason ?? `Connector ${connector.machineName} is not available for command dispatch.`,
        409,
      );
    }

    const commandId = `cmd_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    store.putCommand({
      command: {
        schemaVersion: "cloud-sync.v1",
        commandId,
        connectorId,
        workspaceId: workspaceSession.activeWorkspace.id,
        repository: connector.repository.repo,
        issuedAt: queuedAt,
        expiresAt: futureTimestamp(1),
        type: request.type as ConnectorCommandType,
        payload: normalizeCommandPayload(request),
      },
      status: "pending",
      updatedAt: queuedAt,
      acknowledgedAt: null,
      leaseExpiresAt: null,
      attemptCount: 0,
      nextAttemptAt: null,
      lastMessage: null,
      result: null,
    });

    return {
      commandId,
      connectorId,
      status: "pending" as const,
      queuedAt,
      message: `${request.type} queued for ${connector.machineName}.`,
    };
  });
}

export function findConnectorForRepository(
  workspaceId: string,
  owner: string,
  name: string,
  workspaceRoot?: string,
  referenceAt = new Date().toISOString(),
) {
  return withControlPlaneState((store) => {
    return (
      store
        .listConnectors(workspaceId)
        .filter((connector) => connector.repository.repo.owner === owner && connector.repository.repo.name === name)
        .filter((connector) =>
          workspaceRoot ? sameWorkspaceRoot(connector.repository.workspaceRoot, workspaceRoot) : true,
        )
        .map((connector) => ({
          connector,
          health: getConnectorDispatchHealth(store, connector, referenceAt),
          latestActivityAt: getLatestConnectorActivityAt(store, connector.id, connector.lastSeenAt),
        }))
        .filter((candidate) => candidate.health.dispatchable)
        .sort((left, right) => {
          const activityDelta = new Date(right.latestActivityAt).getTime() - new Date(left.latestActivityAt).getTime();
          if (activityDelta !== 0) {
            return activityDelta;
          }

          const seenDelta =
            new Date(right.connector.lastSeenAt).getTime() - new Date(left.connector.lastSeenAt).getTime();
          if (seenDelta !== 0) {
            return seenDelta;
          }

          const registeredDelta =
            new Date(right.connector.registeredAt).getTime() - new Date(left.connector.registeredAt).getTime();
          if (registeredDelta !== 0) {
            return registeredDelta;
          }

          return right.connector.id.localeCompare(left.connector.id);
        })[0]?.connector ?? null
    );
  });
}

export function getRepositoryConnectorAvailability(
  workspaceId: string,
  owner: string,
  name: string,
  workspaceRoot?: string,
  referenceAt = new Date().toISOString(),
): RepositoryConnectorAvailability {
  return withControlPlaneState((store) => {
    const matchingConnectors = store
      .listConnectors(workspaceId)
      .filter((connector) => connector.repository.repo.owner === owner && connector.repository.repo.name === name)
      .filter((connector) =>
        workspaceRoot ? sameWorkspaceRoot(connector.repository.workspaceRoot, workspaceRoot) : true,
      )
      .map((connector) => {
        const heartbeat = store.getHeartbeat(connector.id);
        const health = getConnectorDispatchHealth(store, connector, referenceAt);

        return {
          connector,
          heartbeat,
          health,
          latestActivityAt: getLatestConnectorActivityAt(store, connector.id, connector.lastSeenAt),
        };
      })
      .sort((left, right) => {
        const statusPriority = (status: RepositoryConnectorAvailability["status"]) => {
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
        };

        const healthDelta = statusPriority(right.health.status) - statusPriority(left.health.status);
        if (healthDelta !== 0) {
          return healthDelta;
        }

        const activityDelta = new Date(right.latestActivityAt).getTime() - new Date(left.latestActivityAt).getTime();
        if (activityDelta !== 0) {
          return activityDelta;
        }

        return new Date(right.connector.lastSeenAt).getTime() - new Date(left.connector.lastSeenAt).getTime();
      });

    const bestMatch = matchingConnectors[0];
    if (!bestMatch) {
      return {
        status: "missing",
        reason: "No connector has registered for this repository yet.",
        connectorId: null,
        machineName: null,
        lastSeenAt: null,
        daemonReachable: null,
      };
    }

    const daemonReachable = bestMatch.heartbeat?.localDaemon.reachable ?? null;
    const daemonReason =
      daemonReachable === false
        ? "The latest connector heartbeat reported the local authority daemon as offline."
        : null;

    return {
      status: bestMatch.health.status,
      reason: daemonReason ?? bestMatch.health.reason,
      connectorId: bestMatch.connector.id,
      machineName: bestMatch.connector.machineName,
      lastSeenAt: bestMatch.connector.lastSeenAt,
      daemonReachable,
    };
  });
}
