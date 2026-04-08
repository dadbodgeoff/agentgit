import { NextResponse } from "next/server";

import { requireApiSession } from "@/lib/auth/api-session";
import { listRepositoryInventory } from "@/lib/backend/workspace/repository-inventory";
import { getRepositoriesFixture } from "@/mocks/fixtures";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";
import { isPaginationQueryError, paginateItems, parseCursorPaginationQuery } from "@/lib/pagination/cursor";
import { PreviewStateSchema } from "@/schemas/cloud";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(request: Request): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const { unauthorized, workspaceSession } = await requireApiSession(request);

  if (unauthorized) {
    return unauthorized;
  }

  const url = new URL(request.url);
  const parsed = PreviewStateSchema.safeParse(url.searchParams.get("state") ?? "ready");
  const previewState = parsed.success ? parsed.data : "ready";
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
    const fixture = getRepositoriesFixture(previewState);
    return jsonWithRequestId({ ...fixture, ...paginateItems(fixture.items, pagination) }, undefined, requestId);
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
        message:
          error instanceof Error && error.message.length > 0 ? error.message : "Could not load repositories. Retry.",
      },
      { status: 500 },
      requestId,
    );
  }
}
