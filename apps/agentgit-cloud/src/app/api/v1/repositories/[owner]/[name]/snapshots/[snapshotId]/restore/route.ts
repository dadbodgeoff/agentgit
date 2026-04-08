import { NextResponse } from "next/server";

import { requireApiRole } from "@/lib/auth/api-session";
import {
  RepositorySnapshotRestoreError,
  restoreRepositorySnapshot,
} from "@/lib/backend/workspace/repository-snapshots";
import { readJsonBody, JsonBodyParseError } from "@/lib/http/request-body";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";
import { SnapshotRestoreRequestSchema } from "@/schemas/cloud";

export async function POST(
  request: Request,
  context: { params: Promise<{ owner: string; name: string; snapshotId: string }> },
): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const access = await requireApiRole("admin", request);

  if (access.denied) {
    return access.denied;
  }

  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(request);
  } catch (error) {
    if (error instanceof JsonBodyParseError) {
      return jsonWithRequestId({ message: error.message }, { status: 400 }, requestId);
    }
    throw error;
  }
  const parsed = SnapshotRestoreRequestSchema.safeParse(rawBody);

  if (!parsed.success) {
    return jsonWithRequestId(
      { message: "Snapshot restore payload is invalid.", issues: parsed.error.flatten() },
      { status: 400 },
      requestId,
    );
  }

  const { owner, name, snapshotId } = await context.params;

  try {
    const result = await restoreRepositorySnapshot(
      owner,
      name,
      snapshotId,
      parsed.data.intent,
      requestId,
      access.workspaceSession.activeWorkspace.id,
    );

    return jsonWithRequestId(result, undefined, requestId);
  } catch (error) {
    if (error instanceof RepositorySnapshotRestoreError) {
      return jsonWithRequestId({ message: error.message }, { status: error.statusCode }, requestId);
    }

    logRouteError("repository_snapshot_restore_post", requestId, error, { owner, name, snapshotId });
    return jsonWithRequestId({ message: "Could not complete snapshot recovery. Retry." }, { status: 500 }, requestId);
  }
}
