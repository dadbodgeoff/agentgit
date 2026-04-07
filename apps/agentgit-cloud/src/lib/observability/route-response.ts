import "server-only";

import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";

import { logServerEvent } from "@/lib/observability/logger";

export function createRequestId(request: Request): string {
  const upstreamRequestId = request.headers.get("x-request-id")?.trim();
  return upstreamRequestId && upstreamRequestId.length > 0 ? upstreamRequestId : crypto.randomUUID();
}

export function jsonWithRequestId(body: unknown, init: ResponseInit | undefined, requestId: string): NextResponse {
  const headers = new Headers(init?.headers);
  headers.set("x-agentgit-request-id", requestId);

  return NextResponse.json(body, {
    ...init,
    headers,
  });
}

export function logRouteError(
  route: string,
  requestId: string,
  error: unknown,
  details: Record<string, unknown> = {},
): void {
  Sentry.captureException(error, {
    tags: {
      route,
      requestId,
    },
    extra: details,
  });
  logServerEvent("error", "cloud_route_error", {
    route,
    requestId,
    errorMessage: error instanceof Error ? error.message : String(error),
    ...details,
  });
}
