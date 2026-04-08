import { NextResponse } from "next/server";

import { requireApiSession } from "@/lib/auth/api-session";
import { listRepositoryInventory } from "@/lib/backend/workspace/repository-inventory";
import { loadPreviewFixture, resolvePreviewState } from "@/lib/dev/preview-fixtures";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";
import { isPaginationQueryError, paginateItems, parseCursorPaginationQuery } from "@/lib/pagination/cursor";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(request: Request): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const { unauthorized, workspaceSession } = await requireApiSession(request);

  if (unauthorized) {
    return unauthorized;
  }

  const previewState = resolvePreviewState(request);
  let pagination;

  try {
    pagination = parseCursorPaginationQuery(request);
  } catch (error) {
    if (isPaginationQueryError(error)) {
      return jsonWithRequestId({ message: "Pagination parameters are invalid." }, { status: 400 }, requestId);
    }

    throw error;
  }

  if (previewState === "loading") {
    await sleep(1200);
  }

  if (previewState === "error") {
    return jsonWithRequestId({ message: "Could not load repositories. Retry." }, { status: 500 }, requestId);
  }

  if (previewState !== "ready") {
    const fixture = await loadPreviewFixture("repositories", previewState);
    if (fixture) {
      return jsonWithRequestId({ ...fixture, ...paginateItems(fixture.items, pagination) }, undefined, requestId);
    }
  }

  try {
    return jsonWithRequestId(
      await listRepositoryInventory(workspaceSession.activeWorkspace.id, pagination),
      undefined,
      requestId,
    );
  } catch (error) {
    logRouteError("repository_inventory", requestId, error);
    return jsonWithRequestId(
      {
        message: "Could not load repositories. Retry.",
      },
      { status: 500 },
      requestId,
    );
  }
}
