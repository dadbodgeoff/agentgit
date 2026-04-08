import { NextResponse } from "next/server";

import { requireApiRole } from "@/lib/auth/api-session";
import { readJsonBody, JsonBodyParseError } from "@/lib/http/request-body";
import { sendWorkspaceIntegrationTest } from "@/lib/backend/workspace/workspace-integrations";
import { createRequestId, jsonWithRequestId } from "@/lib/observability/route-response";
import { IntegrationTestRequestSchema } from "@/schemas/cloud";

export async function POST(request: Request): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const access = await requireApiRole("admin", request);

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

  const payload = IntegrationTestRequestSchema.safeParse(rawPayload);

  if (!payload.success) {
    return jsonWithRequestId({ message: "Test notification payload is invalid." }, { status: 400 }, requestId);
  }

  try {
    return jsonWithRequestId(
      await sendWorkspaceIntegrationTest(access.workspaceSession, payload.data.channel),
      undefined,
      requestId,
    );
  } catch (error) {
    return jsonWithRequestId(
      {
        message:
          error instanceof Error && error.message.length > 0
            ? error.message
            : "Could not confirm test notification delivery.",
      },
      { status: 409 },
      requestId,
    );
  }
}
