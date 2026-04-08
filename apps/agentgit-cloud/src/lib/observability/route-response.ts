import "server-only";

import { createHash } from "node:crypto";
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
  if (!headers.has("cache-control")) {
    headers.set("cache-control", "private, no-store");
  }

  return NextResponse.json(body, {
    ...init,
    headers,
  });
}

export function publicRouteErrorMessage(fallback: string): string {
  return fallback;
}

function redactIdentifier(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "[redacted]";
  }

  return `redacted:${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12)}`;
}

function sanitizeLogDetails(details: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details)) {
    if (key === "workspaceId" || key === "machineName") {
      sanitized[key] = redactIdentifier(value);
      continue;
    }
    if (/(body|secret|token|authorization|cookie|password)/i.test(key)) {
      sanitized[key] = "[redacted]";
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

export function logRouteError(
  route: string,
  requestId: string,
  error: unknown,
  details: Record<string, unknown> = {},
): void {
  const sanitizedDetails = sanitizeLogDetails(details);
  Sentry.captureException(error, {
    tags: {
      route,
      requestId,
    },
    extra: sanitizedDetails,
  });
  logServerEvent("error", "cloud_route_error", {
    route,
    requestId,
    errorMessage: error instanceof Error ? error.name : "UnknownError",
    ...sanitizedDetails,
  });
}
