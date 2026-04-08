import { NextResponse } from "next/server";

import { requireApiRole } from "@/lib/auth/api-session";
import {
  RepositoryPolicyInputError,
  RepositoryPolicyVersionNotFoundError,
  rollbackRepositoryPolicyVersion,
  resolveRepositoryPolicy,
  saveRepositoryPolicy,
  validateRepositoryPolicyDocument,
} from "@/lib/backend/workspace/repository-policy";
import { readJsonBody, JsonBodyParseError } from "@/lib/http/request-body";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";
import { PreviewStateSchema, RepositoryPolicyDocumentInputSchema } from "@/schemas/cloud";

const POLICY_VERSION_ID_PATTERN = /^polver_[a-z0-9]+$/u;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(
  request: Request,
  context: { params: Promise<{ owner: string; name: string }> },
): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const access = await requireApiRole("admin", request);

  if (access.denied) {
    return access.denied;
  }

  const url = new URL(request.url);
  const parsed = PreviewStateSchema.safeParse(url.searchParams.get("state") ?? "ready");
  const previewState = parsed.success ? parsed.data : "ready";

  if (previewState === "loading") {
    await sleep(1200);
  }

  if (previewState === "error") {
    return jsonWithRequestId({ message: "Could not load repository policy. Retry." }, { status: 500 }, requestId);
  }

  const { owner, name } = await context.params;

  try {
    const policy = await resolveRepositoryPolicy(owner, name, access.workspaceSession.activeWorkspace.id);
    if (!policy) {
      return jsonWithRequestId({ message: "Repository policy was not found." }, { status: 404 }, requestId);
    }

    return jsonWithRequestId(policy, undefined, requestId);
  } catch (error) {
    logRouteError("repository_policy_get", requestId, error, { owner, name });
    return jsonWithRequestId({ message: "Could not load repository policy. Retry." }, { status: 500 }, requestId);
  }
}

export async function POST(
  request: Request,
  _context: { params: Promise<{ owner: string; name: string }> },
): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const access = await requireApiRole("admin", request);

  if (access.denied) {
    return access.denied;
  }

  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(request);
  } catch (error) {
    if (error instanceof JsonBodyParseError) {
      return jsonWithRequestId({ message: error.message }, { status: 400 }, requestId);
    }
    throw error;
  }
  const parsed = RepositoryPolicyDocumentInputSchema.safeParse(rawBody);

  if (!parsed.success) {
    return jsonWithRequestId(
      { message: "Policy validation payload is invalid.", issues: parsed.error.flatten() },
      { status: 400 },
      requestId,
    );
  }

  return jsonWithRequestId(validateRepositoryPolicyDocument(parsed.data.document), undefined, requestId);
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ owner: string; name: string }> },
): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const access = await requireApiRole("admin", request);

  if (access.denied) {
    return access.denied;
  }

  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(request);
  } catch (error) {
    if (error instanceof JsonBodyParseError) {
      return jsonWithRequestId({ message: error.message }, { status: 400 }, requestId);
    }
    throw error;
  }
  const parsed = RepositoryPolicyDocumentInputSchema.safeParse(rawBody);

  if (!parsed.success) {
    return jsonWithRequestId(
      { message: "Policy save payload is invalid.", issues: parsed.error.flatten() },
      { status: 400 },
      requestId,
    );
  }

  const { owner, name } = await context.params;

  try {
    const result = await saveRepositoryPolicy(
      owner,
      name,
      parsed.data.document,
      access.workspaceSession.activeWorkspace.id,
      {
        userId: access.workspaceSession.user.id,
        name: access.workspaceSession.user.name,
        email: access.workspaceSession.user.email,
      },
    );
    if (!result) {
      return jsonWithRequestId({ message: "Repository policy was not found." }, { status: 404 }, requestId);
    }

    return jsonWithRequestId(result, undefined, requestId);
  } catch (error) {
    if (error instanceof RepositoryPolicyInputError) {
      return jsonWithRequestId({ message: error.message, issues: error.issues }, { status: 400 }, requestId);
    }

    logRouteError("repository_policy_put", requestId, error, { owner, name });
    return jsonWithRequestId({ message: "Could not save repository policy. Retry." }, { status: 500 }, requestId);
  }
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ owner: string; name: string }> },
): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const access = await requireApiRole("admin", request);

  if (access.denied) {
    return access.denied;
  }

  let rawBody: unknown;
  try {
    rawBody = await readJsonBody(request);
  } catch (error) {
    if (error instanceof JsonBodyParseError) {
      return jsonWithRequestId({ message: error.message }, { status: 400 }, requestId);
    }
    throw error;
  }
  const versionId =
    rawBody && typeof rawBody === "object" && "versionId" in rawBody && typeof rawBody.versionId === "string"
      ? rawBody.versionId.trim()
      : "";

  if (versionId.length === 0 || !POLICY_VERSION_ID_PATTERN.test(versionId)) {
    return jsonWithRequestId({ message: "Policy rollback payload is invalid." }, { status: 400 }, requestId);
  }

  const { owner, name } = await context.params;

  try {
    const result = await rollbackRepositoryPolicyVersion(
      owner,
      name,
      versionId,
      access.workspaceSession.activeWorkspace.id,
      {
        userId: access.workspaceSession.user.id,
        name: access.workspaceSession.user.name,
        email: access.workspaceSession.user.email,
      },
    );
    if (!result) {
      return jsonWithRequestId({ message: "Repository policy was not found." }, { status: 404 }, requestId);
    }

    return jsonWithRequestId(result, undefined, requestId);
  } catch (error) {
    if (error instanceof RepositoryPolicyVersionNotFoundError) {
      return jsonWithRequestId({ message: error.message }, { status: 404 }, requestId);
    }

    logRouteError("repository_policy_patch", requestId, error, { owner, name, versionId });
    return jsonWithRequestId({ message: "Could not roll back repository policy. Retry." }, { status: 500 }, requestId);
  }
}
