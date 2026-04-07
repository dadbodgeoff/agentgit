import { AuthorityClientTransportError, AuthorityDaemonResponseError } from "@agentgit/authority-sdk";
import { NextResponse } from "next/server";

import { jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";

function mapDaemonErrorStatus(code: string): number {
  switch (code) {
    case "BAD_REQUEST":
    case "VALIDATION_FAILED":
      return 400;
    case "NOT_FOUND":
      return 404;
    case "CONFLICT":
      return 409;
    case "TIMEOUT":
      return 504;
    case "PRECONDITION_FAILED":
    case "POLICY_BLOCKED":
      return 409;
    case "CAPABILITY_UNAVAILABLE":
      return 503;
    case "STORAGE_UNAVAILABLE":
    case "BROKER_UNAVAILABLE":
    case "UPSTREAM_FAILURE":
      return 502;
    default:
      return 500;
  }
}

export function toAuthorityRouteErrorResponse(
  error: unknown,
  fallbackMessage: string,
  options?: { requestId?: string; route?: string },
): NextResponse {
  const requestId = options?.requestId;
  const route = options?.route ?? "authority_route";

  logRouteError(route, requestId ?? "unknown", error);

  function respond(body: unknown, init: ResponseInit): NextResponse {
    return requestId ? jsonWithRequestId(body, init, requestId) : NextResponse.json(body, init);
  }

  if (error instanceof AuthorityClientTransportError) {
    return respond(
      {
        message: "The authority daemon is unavailable. Start the local authority service and retry.",
        details: error.details ?? null,
      },
      { status: 503 },
    );
  }

  if (error instanceof AuthorityDaemonResponseError) {
    return respond(
      {
        message: error.message || fallbackMessage,
        code: error.code,
        details: error.details ?? null,
      },
      { status: mapDaemonErrorStatus(error.code) },
    );
  }

  return respond({ message: fallbackMessage }, { status: 500 });
}
