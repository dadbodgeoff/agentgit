import { NextResponse } from "next/server";

import { requireApiRole } from "@/lib/auth/api-session";
import { getWorkspaceConnectionState, saveWorkspaceConnectionState } from "@/lib/backend/workspace/cloud-state";
import { isWorkspaceSlugOwnedByAnotherWorkspace } from "@/lib/backend/workspace/workspace-scope";
import { loadPreviewFixture, resolvePreviewState } from "@/lib/dev/preview-fixtures";
import { readJsonBody, JsonBodyParseError } from "@/lib/http/request-body";
import { listWorkspaceRepositoryOptions } from "@/lib/backend/workspace/repository-inventory";
import { launchOnboardingFixture } from "@/mocks/fixtures";
import { createRequestId, jsonWithRequestId } from "@/lib/observability/route-response";
import { OnboardingFormValuesSchema } from "@/schemas/cloud";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(request: Request): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const access = await requireApiRole("owner", request);

  if (access.denied) {
    return access.denied;
  }

  const previewState = resolvePreviewState(request);

  if (previewState === "loading") {
    await sleep(1200);
  }

  if (previewState === "error") {
    return jsonWithRequestId({ message: "Could not load onboarding setup. Retry." }, { status: 500 }, requestId);
  }

  if (previewState !== "ready") {
    const fixture = await loadPreviewFixture("onboarding", previewState);
    if (fixture) {
      return jsonWithRequestId(fixture, undefined, requestId);
    }
  }

  const persistedState = await getWorkspaceConnectionState(access.workspaceSession.activeWorkspace.id);
  const availableRepositories = await listWorkspaceRepositoryOptions(access.workspaceSession.activeWorkspace.id);

  return jsonWithRequestId(
    {
      suggestedWorkspaceName: persistedState?.workspaceName ?? access.workspaceSession.activeWorkspace.name,
      suggestedWorkspaceSlug: persistedState?.workspaceSlug ?? access.workspaceSession.activeWorkspace.slug,
      availableRepositories,
      connectedRepositoryIds: persistedState?.repositoryIds ?? [],
      invites: persistedState?.invites ?? [],
      defaultNotificationChannel: persistedState?.defaultNotificationChannel ?? "slack",
      recommendedPolicyPack: persistedState?.policyPack ?? "guarded",
      launchedAt: persistedState?.launchedAt,
    },
    undefined,
    requestId,
  );
}

export async function POST(request: Request): Promise<NextResponse> {
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

  const payload = OnboardingFormValuesSchema.safeParse(rawPayload);

  if (!payload.success) {
    return jsonWithRequestId({ message: "Onboarding payload is invalid." }, { status: 400 }, requestId);
  }

  if (access.workspaceSession.activeWorkspace.role !== "owner") {
    return jsonWithRequestId({ message: "Only workspace owners can launch onboarding." }, { status: 403 }, requestId);
  }

  const availableRepositories = await listWorkspaceRepositoryOptions(access.workspaceSession.activeWorkspace.id);
  const knownRepositoryIds = new Set(availableRepositories.map((repository) => repository.id));
  const hasUnknownRepository = payload.data.repositoryIds.some((repositoryId) => !knownRepositoryIds.has(repositoryId));

  if (hasUnknownRepository) {
    return jsonWithRequestId(
      { message: "One or more selected repositories could not be found." },
      { status: 400 },
      requestId,
    );
  }

  const currentUserEmail = access.workspaceSession.user.email.trim().toLowerCase();
  if (payload.data.invites.some((invite) => invite.email.trim().toLowerCase() === currentUserEmail)) {
    return jsonWithRequestId(
      { message: "Workspace owner cannot be added again through onboarding invites." },
      { status: 400 },
      requestId,
    );
  }

  if (
    await isWorkspaceSlugOwnedByAnotherWorkspace(payload.data.workspaceSlug, access.workspaceSession.activeWorkspace.id)
  ) {
    return jsonWithRequestId({ message: "Workspace slug is already in use." }, { status: 409 }, requestId);
  }

  const launchedAt = new Date().toISOString();
  const savedState = await saveWorkspaceConnectionState({
    workspaceId: access.workspaceSession.activeWorkspace.id,
    workspaceName: payload.data.workspaceName,
    workspaceSlug: payload.data.workspaceSlug,
    repositoryIds: payload.data.repositoryIds,
    members: [
      {
        name: access.workspaceSession.user.name,
        email: access.workspaceSession.user.email,
        role: "owner",
      },
    ],
    invites: payload.data.invites,
    defaultNotificationChannel: payload.data.defaultNotificationChannel,
    policyPack: payload.data.policyPack,
    launchedAt,
  });

  return jsonWithRequestId(
    {
      ...launchOnboardingFixture(payload.data),
      workspaceId: savedState.workspaceId,
      launchedAt,
    },
    undefined,
    requestId,
  );
}
