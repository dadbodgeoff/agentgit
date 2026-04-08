import "server-only";

import fs from "node:fs";
import path from "node:path";

import { AuthorityClientTransportError } from "@agentgit/authority-sdk";
import { RunJournal, type RunJournalEventRecord } from "@agentgit/run-journal";
import { LocalSnapshotEngine } from "@agentgit/snapshot-engine";

import { withScopedAuthorityClient } from "@/lib/backend/authority/client";
import { findConnectorForRepository, queueConnectorCommand } from "@/lib/backend/control-plane/connectors";
import { withControlPlaneState } from "@/lib/backend/control-plane/state";
import { findRepositoryRuntimeRecord } from "@/lib/backend/workspace/repository-inventory";
import {
  RepositorySnapshotsResponseSchema,
  SnapshotRestoreQueuedResponseSchema,
  SnapshotRestorePreviewSchema,
  type RepositorySnapshotListItem,
  type RepositorySnapshotRecovery,
  type RepositorySnapshotsResponse,
  type SnapshotIntegrityStatus,
  type SnapshotRestoreQueuedResponse,
  type SnapshotRestoreIntent,
  type SnapshotRestorePreview,
} from "@/schemas/cloud";

type ActionContext = {
  actionSummary: string;
  targetLocator: string;
};

type SnapshotEventContext = {
  actionId: string;
  createdAt: string;
  fidelity: string;
  runId: string;
  sequence: number;
  snapshotClass: string;
  snapshotId: string;
  workflowName: string;
};

type RepositorySnapshotRuntime = {
  repository: NonNullable<ReturnType<typeof findRepositoryRuntimeRecord>>;
  snapshots: RepositorySnapshotsResponse;
};

export class RepositorySnapshotRestoreError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "RepositorySnapshotRestoreError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function getJournalPath(repoRoot: string): string {
  return path.join(repoRoot, ".agentgit", "state", "authority.db");
}

function getSnapshotRoot(repoRoot: string): string {
  return path.join(repoRoot, ".agentgit", "state", "snapshots");
}

function createSnapshotEngine(repoRoot: string) {
  return new LocalSnapshotEngine({
    rootDir: getSnapshotRoot(repoRoot),
  });
}

function normalizePathForComparison(input: string): string {
  const resolved = path.resolve(input);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function isSameOrNestedPath(candidate: string, base: string): boolean {
  const normalizedCandidate = normalizePathForComparison(candidate);
  const normalizedBase = normalizePathForComparison(base);
  return normalizedCandidate === normalizedBase || normalizedCandidate.startsWith(`${normalizedBase}${path.sep}`);
}

function makeActionKey(runId: string, actionId: string): string {
  return `${runId}:${actionId}`;
}

function readPayloadString(event: RunJournalEventRecord, key: string): string | null {
  return typeof event.payload?.[key] === "string" ? (event.payload[key] as string) : null;
}

function relativeScopePath(repoRoot: string, targetPath: string | null): string[] {
  if (!targetPath) {
    return ["workspace"];
  }

  if (!isSameOrNestedPath(targetPath, repoRoot)) {
    return [targetPath];
  }

  const relative = path.relative(repoRoot, targetPath);
  return [relative.length > 0 ? relative : "workspace"];
}

function toReadableSummary(domain: string | null, operation: string | null, targetLocator: string): string {
  if (domain && operation) {
    return `${domain} / ${operation} on ${targetLocator}`;
  }

  if (operation) {
    return `${operation} on ${targetLocator}`;
  }

  if (domain) {
    return `${domain} change on ${targetLocator}`;
  }

  return `Governed change on ${targetLocator}`;
}

function readActionContext(event: RunJournalEventRecord): ActionContext | null {
  const actionPayload = isObject(event.payload?.action) ? event.payload.action : null;
  const actionOperation = actionPayload && isObject(actionPayload.operation) ? actionPayload.operation : null;
  const targetPayload =
    actionPayload &&
    isObject(actionPayload.target) &&
    isObject(actionPayload.target.primary) &&
    typeof actionPayload.target.primary.locator === "string"
      ? actionPayload.target.primary.locator
      : null;
  const targetLocator = readPayloadString(event, "target_locator") ?? targetPayload ?? "workspace";
  const operationDisplayName =
    actionOperation && typeof actionOperation.display_name === "string" && actionOperation.display_name.length > 0
      ? actionOperation.display_name
      : null;
  const operationKind =
    actionOperation && typeof actionOperation.kind === "string" && actionOperation.kind.length > 0
      ? actionOperation.kind
      : null;
  const operationDomain =
    actionOperation && typeof actionOperation.domain === "string" && actionOperation.domain.length > 0
      ? actionOperation.domain
      : null;

  return {
    actionSummary: operationDisplayName ?? toReadableSummary(operationDomain, operationKind, targetLocator),
    targetLocator,
  };
}

function toRecoverySummary(event: RunJournalEventRecord): RepositorySnapshotRecovery | null {
  const executedAt = event.occurred_at;
  const outcome = readPayloadString(event, "outcome");
  const recoveryClass = readPayloadString(event, "recovery_class");
  const strategy = readPayloadString(event, "strategy");

  if (!outcome || !recoveryClass || !strategy) {
    return null;
  }

  return {
    executedAt,
    outcome: outcome === "compensated" ? "compensated" : "restored",
    recoveryClass,
    strategy,
  };
}

async function isAuthorityReachable(repoRoot: string): Promise<boolean> {
  try {
    await withScopedAuthorityClient([repoRoot], async (client) => client.getCapabilities(repoRoot));
    return true;
  } catch (error) {
    if (error instanceof AuthorityClientTransportError) {
      return false;
    }

    return false;
  }
}

async function buildSnapshotItem(params: {
  actionContext: ActionContext | null;
  event: SnapshotEventContext;
  latestRecovery: RepositorySnapshotRecovery | undefined;
  latestRestoreCommand:
    | {
        commandId: string;
        status: "pending" | "acked" | "completed" | "failed" | "expired";
        updatedAt: string;
        message: string | null;
        runId: string | null;
        actionId: string | null;
      }
    | null;
  repoRoot: string;
}): Promise<RepositorySnapshotListItem> {
  const engine = createSnapshotEngine(params.repoRoot);
  const manifest = await engine.getSnapshotManifest(params.event.snapshotId);
  const integrityStatus: SnapshotIntegrityStatus = (await engine.verifyIntegrity(params.event.snapshotId))
    ? "verified"
    : "missing";
  const targetLocator = manifest?.target_path ?? params.actionContext?.targetLocator ?? "workspace";

  return {
    snapshotId: params.event.snapshotId,
    runId: params.event.runId,
    actionId: params.event.actionId,
    workflowName: params.event.workflowName,
    actionSummary:
      manifest?.action_display_name ??
      params.actionContext?.actionSummary ??
      toReadableSummary(manifest?.operation_domain ?? null, manifest?.operation_kind ?? null, targetLocator),
    targetLocator,
    snapshotClass: params.event.snapshotClass,
    fidelity: params.event.fidelity,
    scopePaths: relativeScopePath(params.repoRoot, manifest?.target_path ?? targetLocator),
    integrityStatus,
    storageBytes: null,
    createdAt: params.event.createdAt,
    latestRecovery: params.latestRecovery,
    latestRestoreCommandId: params.latestRestoreCommand?.commandId ?? null,
    latestRestoreCommandStatus: params.latestRestoreCommand?.status ?? null,
    latestRestoreCommandUpdatedAt: params.latestRestoreCommand?.updatedAt ?? null,
    latestRestoreCommandMessage: params.latestRestoreCommand?.message ?? null,
    latestRestoreRunId: params.latestRestoreCommand?.runId ?? null,
    latestRestoreActionId: params.latestRestoreCommand?.actionId ?? null,
  };
}

async function resolveRepositorySnapshotRuntime(
  owner: string,
  name: string,
  workspaceId?: string,
): Promise<RepositorySnapshotRuntime | null> {
  const repository = findRepositoryRuntimeRecord(owner, name, workspaceId);
  if (!repository) {
    return null;
  }

  const journalPath = getJournalPath(repository.metadata.root);
  const authorityReachable = await isAuthorityReachable(repository.metadata.root);

  if (!fs.existsSync(journalPath)) {
    return {
      repository,
      snapshots: RepositorySnapshotsResponseSchema.parse({
        items: [],
        total: 0,
        page: 1,
        per_page: 25,
        has_more: false,
        authorityReachable,
        restorableCount: 0,
        restoredCount: 0,
      }),
    };
  }

  const journal = new RunJournal({ dbPath: journalPath });

  try {
    const runs = journal
      .listAllRuns()
      .filter((run) =>
        run.workspace_roots.some((workspaceRoot) => isSameOrNestedPath(workspaceRoot, repository.metadata.root)),
      );

    const actionContexts = new Map<string, ActionContext>();
    const latestRecoveryBySnapshot = new Map<string, RepositorySnapshotRecovery>();
    const latestRestoreCommandBySnapshot = withControlPlaneState((store) => {
      const commands = store
        .listCommands()
        .filter(
          (command) =>
            command.command.type === "execute_restore" &&
            command.command.repository.owner === repository.inventory.owner &&
            command.command.repository.name === repository.inventory.name,
        )
        .sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());

      const bySnapshot = new Map<
        string,
        {
          commandId: string;
          status: "pending" | "acked" | "completed" | "failed" | "expired";
          updatedAt: string;
          message: string | null;
          runId: string | null;
          actionId: string | null;
        }
      >();
      for (const command of commands) {
        const snapshotId =
          typeof command.command.payload.snapshotId === "string" ? command.command.payload.snapshotId : null;
        if (!snapshotId || bySnapshot.has(snapshotId)) {
          continue;
        }

        bySnapshot.set(snapshotId, {
          commandId: command.command.commandId,
          status: command.status,
          updatedAt: command.updatedAt,
          message: command.lastMessage,
          runId:
            command.result?.type === "execute_restore" && typeof command.result.runId === "string"
              ? command.result.runId
              : null,
          actionId:
            command.result?.type === "execute_restore" && typeof command.result.actionId === "string"
              ? command.result.actionId
              : null,
        });
      }
      return bySnapshot;
    });
    const snapshotEvents: SnapshotEventContext[] = [];

    for (const run of runs) {
      const events = journal.listRunEvents(run.run_id);

      for (const event of events) {
        if (event.event_type === "action.normalized") {
          const actionId = readPayloadString(event, "action_id");
          if (!actionId) {
            continue;
          }

          const context = readActionContext(event);
          if (context) {
            actionContexts.set(makeActionKey(run.run_id, actionId), context);
          }
        }
      }

      for (const event of events) {
        if (event.event_type === "recovery.executed") {
          const snapshotId = readPayloadString(event, "snapshot_id");
          if (!snapshotId) {
            continue;
          }

          const recovery = toRecoverySummary(event);
          if (!recovery) {
            continue;
          }

          const current = latestRecoveryBySnapshot.get(snapshotId);
          if (!current || new Date(recovery.executedAt).getTime() > new Date(current.executedAt).getTime()) {
            latestRecoveryBySnapshot.set(snapshotId, recovery);
          }
        }
      }

      for (const event of events) {
        if (event.event_type !== "snapshot.created") {
          continue;
        }

        const snapshotId = readPayloadString(event, "snapshot_id");
        const actionId = readPayloadString(event, "action_id");

        if (!snapshotId || !actionId) {
          continue;
        }

        snapshotEvents.push({
          snapshotId,
          actionId,
          runId: run.run_id,
          workflowName: run.workflow_name,
          snapshotClass: readPayloadString(event, "snapshot_class") ?? "unknown",
          fidelity: readPayloadString(event, "fidelity") ?? "unknown",
          createdAt: event.occurred_at,
          sequence: event.sequence,
        });
      }
    }

    const items = await Promise.all(
      snapshotEvents.map((event) =>
        buildSnapshotItem({
          event,
          repoRoot: repository.metadata.root,
          actionContext: actionContexts.get(makeActionKey(event.runId, event.actionId)) ?? null,
          latestRecovery: latestRecoveryBySnapshot.get(event.snapshotId),
          latestRestoreCommand: latestRestoreCommandBySnapshot.get(event.snapshotId) ?? null,
        }),
      ),
    );

    items.sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());

    return {
      repository,
      snapshots: RepositorySnapshotsResponseSchema.parse({
        items,
        total: items.length,
        page: 1,
        per_page: items.length === 0 ? 25 : items.length,
        has_more: false,
        authorityReachable,
        restorableCount: items.filter((item) => item.integrityStatus === "verified").length,
        restoredCount: items.filter((item) => item.latestRecovery).length,
      }),
    };
  } finally {
    journal.close();
  }
}

async function requireSnapshotRuntime(
  owner: string,
  name: string,
  snapshotId: string,
  workspaceId?: string,
): Promise<{
  repository: RepositorySnapshotRuntime["repository"];
  snapshot: RepositorySnapshotListItem;
}> {
  const runtime = await resolveRepositorySnapshotRuntime(owner, name, workspaceId);
  if (!runtime) {
    throw new RepositorySnapshotRestoreError("Repository snapshot inventory was not found.", 404);
  }

  const snapshot = runtime.snapshots.items.find((entry) => entry.snapshotId === snapshotId);
  if (!snapshot) {
    throw new RepositorySnapshotRestoreError("Snapshot was not found for this repository.", 404);
  }

  if (snapshot.integrityStatus !== "verified") {
    throw new RepositorySnapshotRestoreError(
      "Snapshot manifest is missing, so this restore point is no longer restorable.",
      409,
    );
  }

  if (!runtime.snapshots.authorityReachable) {
    throw new RepositorySnapshotRestoreError(
      "Authority daemon is unavailable, so snapshot recovery cannot be planned right now.",
      503,
    );
  }

  return {
    repository: runtime.repository,
    snapshot,
  };
}

export async function listRepositorySnapshots(
  owner: string,
  name: string,
  workspaceId?: string,
): Promise<RepositorySnapshotsResponse | null> {
  const runtime = await resolveRepositorySnapshotRuntime(owner, name, workspaceId);
  return runtime?.snapshots ?? null;
}

export async function restoreRepositorySnapshot(
  owner: string,
  name: string,
  snapshotId: string,
  intent: Extract<SnapshotRestoreIntent, "plan" | "execute">,
  requestId: string,
  workspaceId?: string,
): Promise<SnapshotRestorePreview | SnapshotRestoreQueuedResponse> {
  const runtime = await requireSnapshotRuntime(owner, name, snapshotId, workspaceId);

  try {
    if (intent === "plan") {
      const result = await withScopedAuthorityClient([runtime.repository.metadata.root], async (client) =>
        client.planRecovery(snapshotId),
      );

      return SnapshotRestorePreviewSchema.parse({
        snapshotId,
        plan: result.recovery_plan,
      });
    }

    if (!workspaceId) {
      throw new RepositorySnapshotRestoreError(
        "Workspace context is required to execute a connector restore.",
        401,
      );
    }

    const connector = findConnectorForRepository(
      workspaceId,
      owner,
      name,
      runtime.repository.metadata.root,
    );
    if (!connector) {
      throw new RepositorySnapshotRestoreError(
        "No registered connector is available for this repository, so restore execution cannot be queued.",
        409,
      );
    }

    const queued = queueConnectorCommand(
      {
        user: {
          id: "system",
          name: "System",
          email: "system@agentgit.dev",
        },
        activeWorkspace: {
          id: workspaceId,
          name: runtime.repository.metadata.name,
          slug: connector.workspaceSlug,
          role: "admin",
        },
      },
      connector.id,
      {
        type: "execute_restore",
        snapshotId,
      },
      new Date().toISOString(),
    );

    return SnapshotRestoreQueuedResponseSchema.parse({
      snapshotId,
      commandId: queued.commandId,
      connectorId: queued.connectorId,
      queuedAt: queued.queuedAt,
      message: `Restore queued for ${connector.machineName}. The connector will execute it locally and sync the resulting recovery event.`,
    });
  } catch (error) {
    if (error instanceof RepositorySnapshotRestoreError) {
      throw error;
    }

    if (error instanceof AuthorityClientTransportError) {
      throw new RepositorySnapshotRestoreError(
        "Authority daemon is unavailable, so snapshot recovery cannot be completed right now.",
        503,
      );
    }

    throw error;
  }
}
