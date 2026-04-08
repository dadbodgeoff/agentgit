import "server-only";

import { desc, eq } from "drizzle-orm";

import { getCloudDatabase, hasDatabaseUrl } from "@/lib/db/client";
import { cloudAuditEvents } from "@/lib/db/schema";
import { sanitizeExternalUrl } from "@/lib/security/external-url";
import { AuditEntrySchema, type AuditEntry } from "@/schemas/cloud";

export type WorkspaceAuditEntryInput = AuditEntry & {
  workspaceId: string;
};

function normalizeAuditEntry(input: WorkspaceAuditEntryInput): WorkspaceAuditEntryInput {
  const parsed = AuditEntrySchema.parse({
    ...input,
    detailPath: input.detailPath ?? null,
    externalUrl: sanitizeExternalUrl(input.externalUrl ?? null),
  });

  return {
    workspaceId: input.workspaceId,
    ...parsed,
  };
}

export async function appendWorkspaceAuditEntry(input: WorkspaceAuditEntryInput): Promise<void> {
  if (!hasDatabaseUrl()) {
    return;
  }

  const entry = normalizeAuditEntry(input);
  const db = getCloudDatabase();
  await db
    .insert(cloudAuditEvents)
    .values({
      id: entry.id,
      workspaceId: entry.workspaceId,
      occurredAt: new Date(entry.occurredAt),
      actorLabel: entry.actorLabel,
      actorType: entry.actorType,
      category: entry.category,
      action: entry.action,
      target: entry.target,
      outcome: entry.outcome,
      repo: entry.repo,
      runId: entry.runId,
      actionId: entry.actionId,
      detailPath: entry.detailPath ?? null,
      externalUrl: entry.externalUrl ?? null,
      details: entry.details,
      createdAt: new Date(),
    })
    .onConflictDoNothing();
}

export async function appendWorkspaceAuditEntries(inputs: WorkspaceAuditEntryInput[]): Promise<void> {
  if (!hasDatabaseUrl() || inputs.length === 0) {
    return;
  }

  const entries = inputs.map((input) => normalizeAuditEntry(input));
  const db = getCloudDatabase();
  await db
    .insert(cloudAuditEvents)
    .values(
      entries.map((entry) => ({
        id: entry.id,
        workspaceId: entry.workspaceId,
        occurredAt: new Date(entry.occurredAt),
        actorLabel: entry.actorLabel,
        actorType: entry.actorType,
        category: entry.category,
        action: entry.action,
        target: entry.target,
        outcome: entry.outcome,
        repo: entry.repo,
        runId: entry.runId,
        actionId: entry.actionId,
        detailPath: entry.detailPath ?? null,
        externalUrl: entry.externalUrl ?? null,
        details: entry.details,
        createdAt: new Date(),
      })),
    )
    .onConflictDoNothing();
}

export async function listStoredWorkspaceAuditEntries(workspaceId: string): Promise<AuditEntry[]> {
  if (!hasDatabaseUrl()) {
    return [];
  }

  const db = getCloudDatabase();
  const rows = await db.query.cloudAuditEvents.findMany({
    where: eq(cloudAuditEvents.workspaceId, workspaceId),
    orderBy: [desc(cloudAuditEvents.occurredAt), desc(cloudAuditEvents.createdAt)],
  });

  return rows.map((row) =>
    AuditEntrySchema.parse({
      id: row.id,
      occurredAt: row.occurredAt.toISOString(),
      actorLabel: row.actorLabel,
      actorType: row.actorType,
      category: row.category,
      action: row.action,
      target: row.target,
      outcome: row.outcome,
      repo: row.repo,
      runId: row.runId,
      actionId: row.actionId,
      detailPath: row.detailPath,
      externalUrl: sanitizeExternalUrl(row.externalUrl),
      details: row.details,
    }),
  );
}
