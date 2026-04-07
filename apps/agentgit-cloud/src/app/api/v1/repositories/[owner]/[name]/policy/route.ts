import { NextResponse } from "next/server";

import { requireApiRole } from "@/lib/auth/api-session";
import {
  RepositoryPolicyInputError,
  resolveRepositoryPolicy,
  saveRepositoryPolicy,
  validateRepositoryPolicyDocument,
} from "@/lib/backend/workspace/repository-policy";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";
import { PreviewStateSchema, RepositoryPolicyDocumentInputSchema } from "@/schemas/cloud";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(
  request: Request,
  context: { params: Promise<{ owner: string; name: string }> },
): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const access = await requireApiRole("admin");

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
  const access = await requireApiRole("admin");

  if (access.denied) {
    return access.denied;
  }

  const body = await request.json().catch(() => null);
  const parsed = RepositoryPolicyDocumentInputSchema.safeParse(body);

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
  const access = await requireApiRole("admin");

  if (access.denied) {
    return access.denied;
  }

  const body = await request.json().catch(() => null);
  const parsed = RepositoryPolicyDocumentInputSchema.safeParse(body);

  if (!parsed.success) {
    return jsonWithRequestId(
      { message: "Policy save payload is invalid.", issues: parsed.error.flatten() },
      { status: 400 },
      requestId,
    );
  }

  const { owner, name } = await context.params;

  try {
    const result = await saveRepositoryPolicy(owner, name, parsed.data.document, access.workspaceSession.activeWorkspace.id);
    if (!result) {
      return jsonWithRequestId({ message: "Repository policy was not found." }, { status: 404 }, requestId);
    }

    return jsonWithRequestId(result, undefined, requestId);
  } catch (error) {
    if (error instanceof RepositoryPolicyInputError) {
      return jsonWithRequestId(
        { message: error.message, issues: error.issues },
        { status: 400 },
        requestId,
      );
    }

    logRouteError("repository_policy_put", requestId, error, { owner, name });
    return jsonWithRequestId({ message: "Could not save repository policy. Retry." }, { status: 500 }, requestId);
  }
}
