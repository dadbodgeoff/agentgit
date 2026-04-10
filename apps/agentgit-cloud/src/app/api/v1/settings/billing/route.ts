import { NextResponse } from "next/server";

import { requireApiRole } from "@/lib/auth/api-session";
import {
  resolveWorkspaceBilling,
  saveWorkspaceBilling,
  WorkspaceBillingLimitError,
} from "@/lib/backend/workspace/workspace-billing";
import { readJsonBody, JsonBodyParseError } from "@/lib/http/request-body";
import { createRequestId, jsonWithRequestId } from "@/lib/observability/route-response";
import { BillingUpdateSchema, WorkspaceBillingApiSchema } from "@/schemas/cloud";

function toWorkspaceBillingApiResponse(billing: unknown) {
  return WorkspaceBillingApiSchema.parse(billing);
}

export async function GET(request: Request): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const access = await requireApiRole("owner", request);

  if (access.denied) {
    return access.denied;
  }

  return jsonWithRequestId(
    toWorkspaceBillingApiResponse(await resolveWorkspaceBilling(access.workspaceSession)),
    undefined,
    requestId,
  );
}

export async function PUT(request: Request): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const access = await requireApiRole("owner", request);

  if (access.denied) {
    return access.denied;
  }

  let rawPayload: unknown;
  try {
    rawPayload = await readJsonBody(request);
  } catch (error) {
    if (error instanceof JsonBodyParseError) {
      return jsonWithRequestId({ message: error.message }, { status: 400 }, requestId);
    }

    throw error;
  }

  const payload = BillingUpdateSchema.safeParse(rawPayload);

  if (!payload.success) {
    return jsonWithRequestId({ message: "Billing payload is invalid." }, { status: 400 }, requestId);
  }

  try {
    const result = await saveWorkspaceBilling(access.workspaceSession, payload.data);
    return jsonWithRequestId(
      {
        ...result,
        billing: toWorkspaceBillingApiResponse(result.billing),
      },
      undefined,
      requestId,
    );
  } catch (error) {
    if (error instanceof WorkspaceBillingLimitError) {
      return jsonWithRequestId({ message: error.message, breaches: error.breaches }, { status: 409 }, requestId);
    }

    throw error;
  }
}
