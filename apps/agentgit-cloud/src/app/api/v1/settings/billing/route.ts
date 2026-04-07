import { NextResponse } from "next/server";

import { requireApiRole } from "@/lib/auth/api-session";
import { resolveWorkspaceBilling, saveWorkspaceBilling } from "@/lib/backend/workspace/workspace-billing";
import { createRequestId, jsonWithRequestId } from "@/lib/observability/route-response";
import { BillingUpdateSchema } from "@/schemas/cloud";

export async function GET(request: Request): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const access = await requireApiRole("owner");

  if (access.denied) {
    return access.denied;
  }

  return jsonWithRequestId(resolveWorkspaceBilling(access.workspaceSession), undefined, requestId);
}

export async function PUT(request: Request): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const access = await requireApiRole("owner");

  if (access.denied) {
    return access.denied;
  }

  const payload = BillingUpdateSchema.safeParse(await request.json().catch(() => ({})));

  if (!payload.success) {
    return jsonWithRequestId({ message: "Billing payload is invalid." }, { status: 400 }, requestId);
  }

  if (payload.data.invoiceEmail.endsWith("@blocked.example")) {
    return jsonWithRequestId(
      { message: "Invoice destination is blocked. Use a different address." },
      { status: 409 },
      requestId,
    );
  }

  return jsonWithRequestId(saveWorkspaceBilling(access.workspaceSession, payload.data), undefined, requestId);
}
