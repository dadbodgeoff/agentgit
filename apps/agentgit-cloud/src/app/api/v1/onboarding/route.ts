import { NextResponse } from "next/server";

import { requireApiRole } from "@/lib/auth/api-session";
import {
  findWorkspaceConnectionStateBySlug,
  getWorkspaceConnectionState,
  saveWorkspaceConnectionState,
} from "@/lib/backend/workspace/cloud-state";
import { listAllRepositoryOptions } from "@/lib/backend/workspace/repository-inventory";
import { getOnboardingBootstrapFixture, launchOnboardingFixture } from "@/mocks/fixtures";
import { createRequestId, jsonWithRequestId } from "@/lib/observability/route-response";
import { OnboardingFormValuesSchema, PreviewStateSchema } from "@/schemas/cloud";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(request: Request): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const access = await requireApiRole("owner");

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
    return jsonWithRequestId({ message: "Could not load onboarding setup. Retry." }, { status: 500 }, requestId);
  }

  if (previewState !== "ready") {
    return jsonWithRequestId(getOnboardingBootstrapFixture(previewState), undefined, requestId);
  }

  const persistedState = getWorkspaceConnectionState(access.workspaceSession.activeWorkspace.id);
  const availableRepositories = listAllRepositoryOptions();

  return jsonWithRequestId({
    suggestedWorkspaceName: persistedState?.workspaceName ?? access.workspaceSession.activeWorkspace.name,
    suggestedWorkspaceSlug: persistedState?.workspaceSlug ?? access.workspaceSession.activeWorkspace.slug,
    availableRepositories,
    connectedRepositoryIds: persistedState?.repositoryIds ?? [],
    invites: persistedState?.invites ?? [],
    defaultNotificationChannel: persistedState?.defaultNotificationChannel ?? "slack",
    recommendedPolicyPack: persistedState?.policyPack ?? "guarded",
    launchedAt: persistedState?.launchedAt,
  }, undefined, requestId);
}

export async function POST(request: Request): Promise<NextResponse> {
  const requestId = createRequestId(request);
  const access = await requireApiRole("owner");

  if (access.denied) {
    return access.denied;
  }

  const payload = OnboardingFormValuesSchema.safeParse(await request.json().catch(() => ({})));

  if (!payload.success) {
    return jsonWithRequestId({ message: "Onboarding payload is invalid." }, { status: 400 }, requestId);
  }

  const availableRepositories = listAllRepositoryOptions();
  const knownRepositoryIds = new Set(availableRepositories.map((repository) => repository.id));
  const hasUnknownRepository = payload.data.repositoryIds.some((repositoryId) => !knownRepositoryIds.has(repositoryId));

  if (hasUnknownRepository) {
    return jsonWithRequestId(
      { message: "One or more selected repositories could not be found." },
      { status: 400 },
      requestId,
    );
  }

  const matchingWorkspace = findWorkspaceConnectionStateBySlug(payload.data.workspaceSlug);
  if (matchingWorkspace && matchingWorkspace.workspaceId !== access.workspaceSession.activeWorkspace.id) {
    return jsonWithRequestId({ message: "Workspace slug is already in use." }, { status: 409 }, requestId);
  }

  const launchedAt = new Date().toISOString();
  const savedState = saveWorkspaceConnectionState({
    workspaceId: access.workspaceSession.activeWorkspace.id,
    workspaceName: payload.data.workspaceName,
    workspaceSlug: payload.data.workspaceSlug,
    repositoryIds: payload.data.repositoryIds,
    members: [
      {
        name: access.workspaceSession.user.name,
        email: access.workspaceSession.user.email,
        role: access.workspaceSession.activeWorkspace.role,
      },
    ],
    invites: payload.data.invites,
    defaultNotificationChannel: payload.data.defaultNotificationChannel,
    policyPack: payload.data.policyPack,
    launchedAt,
  });

  return jsonWithRequestId({
    ...launchOnboardingFixture(payload.data),
    workspaceId: savedState.workspaceId,
    launchedAt,
  }, undefined, requestId);
}
