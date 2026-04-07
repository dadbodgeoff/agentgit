import { IntegrationState } from "@agentgit/integration-state";
import {
  ConnectorCommandAckRequestSchema,
  ConnectorCommandEnvelopeSchema,
  ConnectorCommandAckResponseSchema,
  ConnectorCommandStatusSchema,
  ConnectorHeartbeatRequestSchema,
  ConnectorLocalDaemonStatusSchema,
  ConnectorRecordSchema,
  ConnectorEventEnvelopeSchema,
  RepositoryStateSnapshotSchema,
} from "@agentgit/cloud-sync-protocol";
import { TimestampStringSchema } from "@agentgit/schemas";
import { z } from "zod";

export const ConnectorTokenRecordSchema = z
  .object({
    tokenHash: z.string().min(1),
    connectorId: z.string().min(1),
    workspaceId: z.string().min(1),
    issuedAt: TimestampStringSchema,
    expiresAt: TimestampStringSchema,
    revokedAt: TimestampStringSchema.nullable(),
  })
  .strict();
export type ConnectorTokenRecord = z.infer<typeof ConnectorTokenRecordSchema>;

export const ConnectorBootstrapTokenRecordSchema = z
  .object({
    tokenHash: z.string().min(1),
    workspaceId: z.string().min(1),
    workspaceSlug: z.string().min(1),
    issuedByUserId: z.string().min(1),
    issuedAt: TimestampStringSchema,
    expiresAt: TimestampStringSchema,
    consumedAt: TimestampStringSchema.nullable(),
    revokedAt: TimestampStringSchema.nullable(),
  })
  .strict();
export type ConnectorBootstrapTokenRecord = z.infer<typeof ConnectorBootstrapTokenRecordSchema>;

export const ConnectorHeartbeatRecordSchema = z
  .object({
    connectorId: z.string().min(1),
    workspaceId: z.string().min(1),
    receivedAt: TimestampStringSchema,
    sentAt: TimestampStringSchema,
    repository: RepositoryStateSnapshotSchema,
    localDaemon: ConnectorLocalDaemonStatusSchema,
  })
  .strict();
export type ConnectorHeartbeatRecord = z.infer<typeof ConnectorHeartbeatRecordSchema>;

export const IngestedConnectorEventSchema = z
  .object({
    event: ConnectorEventEnvelopeSchema,
    ingestedAt: TimestampStringSchema,
  })
  .strict();
export type IngestedConnectorEvent = z.infer<typeof IngestedConnectorEventSchema>;

export const ConnectorCommandRecordSchema = z
  .object({
    command: ConnectorCommandEnvelopeSchema,
    status: ConnectorCommandStatusSchema,
    updatedAt: TimestampStringSchema,
    acknowledgedAt: TimestampStringSchema.nullable(),
    leaseExpiresAt: TimestampStringSchema.nullable(),
    attemptCount: z.number().int().nonnegative(),
    lastMessage: z.string().min(1).nullable(),
  })
  .strict();
export type ConnectorCommandRecord = z.infer<typeof ConnectorCommandRecordSchema>;

type ControlPlaneCollections = {
  connectors: z.infer<typeof ConnectorRecordSchema>;
  connectorTokens: ConnectorTokenRecord;
  connectorBootstrapTokens: ConnectorBootstrapTokenRecord;
  connectorHeartbeats: ConnectorHeartbeatRecord;
  connectorEvents: IngestedConnectorEvent;
  connectorCommands: ConnectorCommandRecord;
};

export class ControlPlaneStateStore {
  private readonly store: IntegrationState<ControlPlaneCollections>;

  constructor(dbPath: string) {
    this.store = new IntegrationState<ControlPlaneCollections>({
      dbPath,
      collections: {
        connectors: {
          parse(_key, value) {
            return ConnectorRecordSchema.parse(value);
          },
        },
        connectorTokens: {
          parse(_key, value) {
            return ConnectorTokenRecordSchema.parse(value);
          },
        },
        connectorBootstrapTokens: {
          parse(_key, value) {
            return ConnectorBootstrapTokenRecordSchema.parse(value);
          },
        },
        connectorHeartbeats: {
          parse(_key, value) {
            return ConnectorHeartbeatRecordSchema.parse(value);
          },
        },
        connectorEvents: {
          parse(_key, value) {
            return IngestedConnectorEventSchema.parse(value);
          },
        },
        connectorCommands: {
          parse(_key, value) {
            return ConnectorCommandRecordSchema.parse(value);
          },
        },
      },
    });
  }

  close(): void {
    this.store.close();
  }

  putConnector(record: z.infer<typeof ConnectorRecordSchema>) {
    return this.store.put("connectors", record.id, record);
  }

  getConnector(connectorId: string) {
    return this.store.get("connectors", connectorId);
  }

  listConnectors(workspaceId?: string) {
    const rows = this.store.list("connectors");
    return workspaceId ? rows.filter((row) => row.workspaceId === workspaceId) : rows;
  }

  putConnectorToken(record: ConnectorTokenRecord) {
    return this.store.put("connectorTokens", record.tokenHash, record);
  }

  getConnectorToken(tokenHash: string) {
    return this.store.get("connectorTokens", tokenHash);
  }

  listConnectorTokens(connectorId?: string) {
    const rows = this.store.list("connectorTokens");
    return connectorId ? rows.filter((row) => row.connectorId === connectorId) : rows;
  }

  putConnectorBootstrapToken(record: ConnectorBootstrapTokenRecord) {
    return this.store.put("connectorBootstrapTokens", record.tokenHash, record);
  }

  getConnectorBootstrapToken(tokenHash: string) {
    return this.store.get("connectorBootstrapTokens", tokenHash);
  }

  putHeartbeat(record: ConnectorHeartbeatRecord) {
    return this.store.put("connectorHeartbeats", record.connectorId, record);
  }

  getHeartbeat(connectorId: string) {
    return this.store.get("connectorHeartbeats", connectorId);
  }

  appendEvent(record: IngestedConnectorEvent) {
    this.store.putIfAbsent("connectorEvents", record.event.eventId, record);
    return record;
  }

  listEvents(connectorId?: string) {
    const rows = this.store.list("connectorEvents");
    return connectorId ? rows.filter((row) => row.event.connectorId === connectorId) : rows;
  }

  getHighestEventSequence(connectorId: string): number {
    return this.listEvents(connectorId).reduce((highest, row) => Math.max(highest, row.event.sequence), 0);
  }

  putCommand(record: ConnectorCommandRecord) {
    return this.store.put("connectorCommands", record.command.commandId, record);
  }

  getCommand(commandId: string) {
    return this.store.get("connectorCommands", commandId);
  }

  updateCommandStatus(params: {
    commandId: string;
    status: z.infer<typeof ConnectorCommandStatusSchema>;
    updatedAt: string;
    acknowledgedAt?: string | null;
    leaseExpiresAt?: string | null;
    attemptCount?: number;
    lastMessage?: string | null;
  }) {
    const current = this.getCommand(params.commandId);
    if (!current) {
      return null;
    }

    return this.putCommand({
      ...current,
      status: params.status,
      updatedAt: params.updatedAt,
      acknowledgedAt: params.acknowledgedAt === undefined ? current.acknowledgedAt : params.acknowledgedAt,
      leaseExpiresAt: params.leaseExpiresAt === undefined ? current.leaseExpiresAt : params.leaseExpiresAt,
      attemptCount: params.attemptCount ?? current.attemptCount,
      lastMessage: params.lastMessage ?? current.lastMessage,
    });
  }

  listCommands(connectorId?: string) {
    const rows = this.store.list("connectorCommands");
    return connectorId ? rows.filter((row) => row.command.connectorId === connectorId) : rows;
  }

  revokeConnector(connectorId: string, revokedAt: string) {
    const connector = this.getConnector(connectorId);
    if (!connector) {
      return null;
    }

    for (const token of this.listConnectorTokens(connectorId)) {
      this.putConnectorToken({
        ...token,
        revokedAt,
      });
    }

    this.putConnector({
      ...connector,
      status: "revoked",
      lastSeenAt: revokedAt,
    });

    return this.getConnector(connectorId);
  }

  retryCommand(commandId: string, retriedAt: string) {
    const current = this.getCommand(commandId);
    if (!current) {
      return null;
    }

    if (current.status !== "failed" && current.status !== "expired") {
      return current;
    }

    return this.putCommand({
      ...current,
      status: "pending",
      updatedAt: retriedAt,
      acknowledgedAt: null,
      leaseExpiresAt: null,
      lastMessage: `Command re-queued at ${retriedAt}.`,
    });
  }

  claimDispatchableCommands(params: {
    connectorId: string;
    claimedAt: string;
    leaseExpiresAt: string;
  }) {
    const now = Date.now();
    const dispatchable: ConnectorCommandRecord[] = [];
    const rows = this.listCommands(params.connectorId).sort(
      (left, right) => new Date(left.command.issuedAt).getTime() - new Date(right.command.issuedAt).getTime(),
    );

    for (const row of rows) {
      if (new Date(row.command.expiresAt).getTime() <= now) {
        this.updateCommandStatus({
          commandId: row.command.commandId,
          status: "expired",
          updatedAt: new Date(now).toISOString(),
          leaseExpiresAt: null,
          lastMessage: "Command expired before connector execution.",
        });
        continue;
      }

      if (row.status === "completed" || row.status === "failed" || row.status === "expired") {
        continue;
      }

      const leaseActive =
        row.leaseExpiresAt !== null && new Date(row.leaseExpiresAt).getTime() > new Date(params.claimedAt).getTime();

      if (row.status === "acked" && leaseActive) {
        continue;
      }

      if (row.status === "pending" && leaseActive) {
        continue;
      }

      const nextStatus = row.status === "acked" ? "pending" : row.status;
      const reclaimedMessage =
        row.status === "acked"
          ? "Connector lease expired after acknowledgement; command returned to pending."
          : row.lastMessage;
      const claimed = this.updateCommandStatus({
        commandId: row.command.commandId,
        status: nextStatus,
        updatedAt: params.claimedAt,
        leaseExpiresAt: params.leaseExpiresAt,
        attemptCount: row.attemptCount + 1,
        lastMessage: reclaimedMessage,
      });
      if (claimed) {
        dispatchable.push(claimed);
      }
    }

    return dispatchable;
  }
}

export function createHeartbeatRecord(params: {
  workspaceId: string;
  receivedAt: string;
  heartbeat: z.infer<typeof ConnectorHeartbeatRequestSchema>;
}): ConnectorHeartbeatRecord {
  return ConnectorHeartbeatRecordSchema.parse({
    connectorId: params.heartbeat.connectorId,
    workspaceId: params.workspaceId,
    receivedAt: params.receivedAt,
    sentAt: params.heartbeat.sentAt,
    repository: params.heartbeat.repository,
    localDaemon: params.heartbeat.localDaemon,
  });
}

export function createCommandAckResponse(params: {
  commandId: string;
  connectorId: string;
  acceptedAt: string;
  status: z.infer<typeof ConnectorCommandAckRequestSchema>["status"];
}) {
  return ConnectorCommandAckResponseSchema.parse({
    schemaVersion: "cloud-sync.v1",
    connectorId: params.connectorId,
    commandId: params.commandId,
    acceptedAt: params.acceptedAt,
    status: params.status,
  });
}
