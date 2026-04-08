import { z } from "zod";

import { requireApiSession } from "@/lib/auth/api-session";
import { exportWorkspaceAuditLog } from "@/lib/backend/workspace/audit-log";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";
import { AuditExportQuerySchema } from "@/schemas/cloud";

const AUDIT_EXPORT_MAX_RECORDS = 5_000;

function parseExportQuery(request: Request) {
  const url = new URL(request.url);
  const raw = {
    format: url.searchParams.get("format") ?? undefined,
    from: url.searchParams.get("from") ?? undefined,
    to: url.searchParams.get("to") ?? undefined,
  };

  return AuditExportQuerySchema.parse(raw);
}

export async function GET(request: Request) {
  const requestId = createRequestId(request);
  const { unauthorized, workspaceSession } = await requireApiSession(request);

  if (unauthorized) {
    return unauthorized;
  }

  try {
    const query = parseExportQuery(request);
    const exported = await exportWorkspaceAuditLog(workspaceSession.activeWorkspace.id, query.format, {
      from: query.from ?? null,
      to: query.to ?? null,
      limit: AUDIT_EXPORT_MAX_RECORDS,
    });

    return new Response(exported.body, {
      status: 200,
      headers: {
        "content-type": exported.contentType,
        "content-disposition": `attachment; filename="${exported.fileName}"`,
        "x-request-id": requestId,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return jsonWithRequestId(
        {
          message: "Invalid audit export parameters.",
          issues: error.issues,
        },
        { status: 400 },
        requestId,
      );
    }

    logRouteError("audit_export_get", requestId, error, {
      workspaceId: workspaceSession.activeWorkspace.id,
    });
    return jsonWithRequestId({ message: "Could not export audit log. Retry." }, { status: 500 }, requestId);
  }
}
