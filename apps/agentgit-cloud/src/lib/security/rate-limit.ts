import "server-only";

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { IntegrationState } from "@agentgit/integration-state";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";

import { getCloudDatabase, hasDatabaseUrl } from "@/lib/db/client";
import { cloudRateLimitBuckets } from "@/lib/db/schema";

type RateLimitScope =
  | "api_ip"
  | "api_workspace"
  | "connector_ip"
  | "connector_workspace"
  | "connector_register_ip"
  | "connector_register_workspace";

type LocalRateLimitBucket = {
  scope: RateLimitScope;
  identifierHash: string;
  count: number;
  resetAt: string;
};

type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: string;
  retryAfterSeconds: number;
};

function getRateLimitDbPath() {
  const root = process.env.AGENTGIT_ROOT ?? process.cwd();
  return path.join(root, ".agentgit", "state", "cloud", "rate-limit.db");
}

function createLocalRateLimitStore() {
  fs.mkdirSync(path.dirname(getRateLimitDbPath()), { recursive: true });

  return new IntegrationState<{
    buckets: LocalRateLimitBucket;
  }>({
    dbPath: getRateLimitDbPath(),
    collections: {
      buckets: {
        parse(_key, value) {
          const candidate = value as LocalRateLimitBucket;
          return {
            scope: candidate.scope,
            identifierHash: candidate.identifierHash,
            count: Number.isFinite(candidate.count) ? candidate.count : 0,
            resetAt: candidate.resetAt,
          };
        },
      },
    },
  });
}

function hashIdentifier(identifier: string) {
  return createHash("sha256").update(identifier, "utf8").digest("hex");
}

function buildBucketKey(scope: RateLimitScope, identifierHash: string, windowMs: number, nowMs: number) {
  const windowSlot = Math.floor(nowMs / windowMs);
  return `${scope}:${identifierHash}:${windowSlot}`;
}

function buildDecision(params: {
  count: number;
  limit: number;
  nowMs: number;
  resetAt: string;
}): RateLimitDecision {
  const resetMs = new Date(params.resetAt).getTime();
  return {
    allowed: params.count <= params.limit,
    limit: params.limit,
    remaining: Math.max(params.limit - params.count, 0),
    resetAt: params.resetAt,
    retryAfterSeconds: Math.max(Math.ceil((resetMs - params.nowMs) / 1000), 1),
  };
}

async function consumeRateLimit(params: {
  scope: RateLimitScope;
  identifier: string;
  limit: number;
  windowMs: number;
}): Promise<RateLimitDecision> {
  const nowMs = Date.now();
  const identifierHash = hashIdentifier(params.identifier);
  const resetAt = new Date(Math.floor(nowMs / params.windowMs) * params.windowMs + params.windowMs).toISOString();
  const bucketKey = buildBucketKey(params.scope, identifierHash, params.windowMs, nowMs);

  if (!hasDatabaseUrl()) {
    const store = createLocalRateLimitStore();
    try {
      for (const bucket of store.list("buckets")) {
        if (new Date(bucket.resetAt).getTime() < nowMs) {
          store.delete("buckets", buildBucketKey(bucket.scope, bucket.identifierHash, params.windowMs, new Date(bucket.resetAt).getTime() - 1));
        }
      }

      const current = store.get("buckets", bucketKey);
      const count = (current?.count ?? 0) + 1;
      store.put("buckets", bucketKey, {
        scope: params.scope,
        identifierHash,
        count,
        resetAt,
      });
      return buildDecision({
        count,
        limit: params.limit,
        nowMs,
        resetAt,
      });
    } finally {
      store.close();
    }
  }

  const db = getCloudDatabase();
  await db.delete(cloudRateLimitBuckets).where(sql`${cloudRateLimitBuckets.resetAt} < ${new Date(nowMs)}`);

  const [row] = await db
    .insert(cloudRateLimitBuckets)
    .values({
      bucketKey,
      scope: params.scope,
      identifierHash,
      count: 1,
      resetAt: new Date(resetAt),
      updatedAt: new Date(nowMs),
    })
    .onConflictDoUpdate({
      target: cloudRateLimitBuckets.bucketKey,
      set: {
        count: sql`${cloudRateLimitBuckets.count} + 1`,
        updatedAt: new Date(nowMs),
      },
    })
    .returning({
      count: cloudRateLimitBuckets.count,
      resetAt: cloudRateLimitBuckets.resetAt,
    });

  return buildDecision({
    count: row?.count ?? 1,
    limit: params.limit,
    nowMs,
    resetAt: row?.resetAt.toISOString() ?? resetAt,
  });
}

function buildRateLimitHeaders(decision: RateLimitDecision) {
  return {
    "retry-after": String(decision.retryAfterSeconds),
    "x-ratelimit-limit": String(decision.limit),
    "x-ratelimit-remaining": String(decision.remaining),
    "x-ratelimit-reset": decision.resetAt,
  };
}

function buildRateLimitResponse(decision: RateLimitDecision, message: string) {
  return NextResponse.json(
    { message },
    {
      status: 429,
      headers: buildRateLimitHeaders(decision),
    },
  );
}

function getClientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const [firstIp] = forwarded.split(",");
    if (firstIp?.trim()) {
      return firstIp.trim();
    }
  }

  const realIp = request.headers.get("x-real-ip") ?? request.headers.get("cf-connecting-ip");
  return realIp?.trim() || "unknown";
}

function isWriteMethod(request: Request) {
  return request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS";
}

export async function enforceApiRateLimits(
  request: Request,
  workspaceId: string,
): Promise<NextResponse | null> {
  const ipDecision = await consumeRateLimit({
    scope: "api_ip",
    identifier: getClientIp(request),
    limit: isWriteMethod(request) ? 120 : 300,
    windowMs: 60_000,
  });
  if (!ipDecision.allowed) {
    return buildRateLimitResponse(ipDecision, "Too many API requests. Retry in a minute.");
  }

  const workspaceDecision = await consumeRateLimit({
    scope: "api_workspace",
    identifier: workspaceId,
    limit: isWriteMethod(request) ? 240 : 900,
    windowMs: 60_000,
  });
  if (!workspaceDecision.allowed) {
    return buildRateLimitResponse(workspaceDecision, "Workspace API quota exceeded. Retry in a minute.");
  }

  return null;
}

export async function enforceConnectorRateLimits(
  request: Request,
  workspaceId: string,
): Promise<NextResponse | null> {
  const ipDecision = await consumeRateLimit({
    scope: "connector_ip",
    identifier: getClientIp(request),
    limit: 240,
    windowMs: 60_000,
  });
  if (!ipDecision.allowed) {
    return buildRateLimitResponse(ipDecision, "Too many connector sync requests. Retry shortly.");
  }

  const workspaceDecision = await consumeRateLimit({
    scope: "connector_workspace",
    identifier: workspaceId,
    limit: 1_200,
    windowMs: 60_000,
  });
  if (!workspaceDecision.allowed) {
    return buildRateLimitResponse(workspaceDecision, "Workspace connector quota exceeded. Retry shortly.");
  }

  return null;
}

export async function enforceConnectorRegistrationRateLimits(
  request: Request,
  workspaceId: string,
): Promise<NextResponse | null> {
  const ipDecision = await consumeRateLimit({
    scope: "connector_register_ip",
    identifier: getClientIp(request),
    limit: 20,
    windowMs: 60_000,
  });
  if (!ipDecision.allowed) {
    return buildRateLimitResponse(ipDecision, "Too many connector registration attempts. Retry in a minute.");
  }

  const workspaceDecision = await consumeRateLimit({
    scope: "connector_register_workspace",
    identifier: workspaceId,
    limit: 40,
    windowMs: 60_000,
  });
  if (!workspaceDecision.allowed) {
    return buildRateLimitResponse(workspaceDecision, "Workspace connector registration quota exceeded. Retry in a minute.");
  }

  return null;
}
