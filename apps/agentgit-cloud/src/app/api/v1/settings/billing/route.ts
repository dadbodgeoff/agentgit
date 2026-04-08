import { NextResponse } from "next/server";

import { requireApiRole } from "@/lib/auth/api-session";
import {
  resolveWorkspaceBilling,
  saveWorkspaceBilling,
  WorkspaceBillingLimitError,
} from "@/lib/backend/workspace/workspace-billing";
import { createRequestId, jsonWithRequestId } from "@/lib/observability/route-response";
import { BillingUpdateSchema } from "@/schemas/cloud";

export async function GET(request: Request): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const access = await requireApiRole("owner", request);

  if (access.denied) {
    return access.denied;
  }

  return jsonWithRequestId(await resolveWorkspaceBilling(access.workspaceSession), undefined, requestId);
}

export async function PUT(request: Request): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const access = await requireApiRole("owner", request);

  if (access.denied) {
    return access.denied;
  }

  const payload = BillingUpdateSchema.safeParse(await request.json().catch(() => ({})));

  if (!payload.success) {
    return jsonWithRequestId({ message: "Billing payload is invalid." }, { status: 400 }, requestId);
  }

  try {
    return jsonWithRequestId(await saveWorkspaceBilling(access.workspaceSession, payload.data), undefined, requestId);
  } catch (error) {
    if (error instanceof WorkspaceBillingLimitError) {
      return jsonWithRequestId({ message: error.message, breaches: error.breaches }, { status: 409 }, requestId);
    }

    throw error;
  }
}
