import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { ConnectorTokenRecord } from "@agentgit/control-plane-state";
import { createCommandAckResponse, createHeartbeatRecord } from "@agentgit/control-plane-state";
import {
  CreateCommitCommandPayloadSchema,
  OpenPullRequestCommandPayloadSchema,
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
import {
  ConnectorBootstrapResponseSchema,
  ConnectorCommandRetryResponseSchema,
  ConnectorRevokeResponseSchema,
  WorkspaceConnectorInventorySchema,
  type ConnectorCommandDispatchRequest,
} from "@/schemas/cloud";
import type { WorkspaceSession } from "@/schemas/cloud";

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

export function ingestConnectorEvents(
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

  return withControlPlaneState((store) => {
    for (const event of batch.events) {
      store.appendEvent({
        event,
        ingestedAt: acceptedAt,
      });
    }

    store.putConnector({
      ...access.connector,
      lastSeenAt: acceptedAt,
      status: "active",
    });

    const highestAcceptedSequence = batch.events.reduce((highest, event) => Math.max(highest, event.sequence), 0);
    return ConnectorEventBatchResponseSchema.parse({
      schemaVersion: "cloud-sync.v1",
      connectorId: access.connector.id,
      acceptedAt,
      acceptedCount: batch.events.length,
      highestAcceptedSequence,
    });
  });
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

    store.updateCommandStatus({
      commandId: request.commandId,
      status: request.status,
      updatedAt: acceptedAt,
      acknowledgedAt: request.status === "acked" || request.status === "completed" ? request.acknowledgedAt : null,
      leaseExpiresAt: request.status === "acked" ? futureMinutesTimestamp(COMMAND_LEASE_MINUTES) : null,
      lastMessage: request.message ?? null,
    });
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

export function listWorkspaceConnectors(workspaceId: string, generatedAt: string) {
  return withControlPlaneState((store) => {
    const items = store
      .listConnectors(workspaceId)
      .map((connector) => {
        const token = store.listConnectorTokens(connector.id).sort((left, right) =>
          new Date(right.issuedAt).getTime() - new Date(left.issuedAt).getTime(),
        )[0] ?? null;
        const heartbeat = store.getHeartbeat(connector.id);
        const commands = store
          .listCommands(connector.id)
          .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
        const events = store
          .listEvents(connector.id)
          .sort(
            (left, right) => new Date(right.event.occurredAt).getTime() - new Date(left.event.occurredAt).getTime(),
          );
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
        const statusDetails = getConnectorStatusDetails(connector.lastSeenAt, Boolean(token?.revokedAt), generatedAt);

        return {
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
                message: lastCommand.lastMessage,
              }
            : null,
          recentCommands: commands.slice(0, 5).map((command) => ({
            commandId: command.command.commandId,
            type: command.command.type,
            status: command.status,
            issuedAt: command.command.issuedAt,
            updatedAt: command.updatedAt,
            acknowledgedAt: command.acknowledgedAt,
            leaseExpiresAt: command.leaseExpiresAt,
            attemptCount: command.attemptCount,
            message: command.lastMessage,
          })),
          recentEvents: events.slice(0, 5).map((event) => ({
            eventId: event.event.eventId,
            type: event.event.type,
            occurredAt: event.event.occurredAt,
          })),
        };
      })
      .sort((left, right) => new Date(right.lastSeenAt).getTime() - new Date(left.lastSeenAt).getTime());

    return WorkspaceConnectorInventorySchema.parse({
      items,
      total: items.length,
      generatedAt,
    });
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

    const retried = store.retryCommand(commandId, retriedAt);
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
          ? `${retried.command.type} returned to the pending queue.`
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
      lastMessage: null,
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

export function findConnectorForRepository(workspaceId: string, owner: string, name: string) {
  return withControlPlaneState((store) => {
    const commandsByConnector = new Map(
      store
        .listCommands()
        .map((command) => [command.command.connectorId, command]),
    );

    return (
      store
        .listConnectors(workspaceId)
        .filter(
          (connector) => connector.repository.repo.owner === owner && connector.repository.repo.name === name,
        )
        .sort((left, right) => {
          const rightCommandTime = commandsByConnector.get(right.id)?.updatedAt ?? right.lastSeenAt;
          const leftCommandTime = commandsByConnector.get(left.id)?.updatedAt ?? left.lastSeenAt;
          return new Date(rightCommandTime).getTime() - new Date(leftCommandTime).getTime();
        })[0] ?? null
    );
  });
}
