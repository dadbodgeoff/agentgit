import { NextResponse } from "next/server";

import { requireApiSession } from "@/lib/auth/api-session";
import { withWorkspaceAuthorityClient } from "@/lib/backend/authority/client";
import { mapApprovalInboxToCloud } from "@/lib/backend/authority/contracts";
import { toAuthorityRouteErrorResponse } from "@/lib/backend/authority/route-errors";
import { listWorkspaceRunContexts } from "@/lib/backend/workspace/workspace-runtime";
import { getApprovalsFixture } from "@/mocks/fixtures";
import { createRequestId, jsonWithRequestId } from "@/lib/observability/route-response";
import { PreviewStateSchema } from "@/schemas/cloud";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(request: Request): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const { unauthorized, workspaceSession } = await requireApiSession();

  if (unauthorized) {
    return unauthorized;
  }

  const url = new URL(request.url);
  const parsed = PreviewStateSchema.safeParse(url.searchParams.get("state") ?? "ready");
  const previewState = parsed.success ? parsed.data : "ready";

  if (previewState === "loading") {
    await sleep(1200);
  }

  if (previewState === "error") {
    return jsonWithRequestId({ message: "Could not load approvals. Retry." }, { status: 500 }, requestId);
  }

  if (previewState !== "ready") {
    return jsonWithRequestId(getApprovalsFixture(previewState), undefined, requestId);
  }

  try {
    const repositoryByRunId = new Map(
      listWorkspaceRunContexts(workspaceSession.activeWorkspace.id).map((context) => [
        context.run.run_id,
        {
          repositoryOwner: context.repository.inventory.owner,
          repositoryName: context.repository.inventory.name,
        },
      ]),
    );
    const approvals = await withWorkspaceAuthorityClient(workspaceSession.activeWorkspace.id, (client) =>
      client.queryApprovalInbox(),
    );
    return jsonWithRequestId(mapApprovalInboxToCloud(approvals, repositoryByRunId), undefined, requestId);
  } catch (error) {
    return toAuthorityRouteErrorResponse(error, "Could not load approvals. Retry.", {
      requestId,
      route: "approval_inbox",
    });
  }
}
