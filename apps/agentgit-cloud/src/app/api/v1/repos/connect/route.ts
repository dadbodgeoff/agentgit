import { requireApiRole } from "@/lib/auth/api-session";
import { listWorkspaceConnectors } from "@/lib/backend/control-plane/connectors";
import { getWorkspaceConnectionState, saveWorkspaceConnectionState } from "@/lib/backend/workspace/cloud-state";
import { readJsonBody, JsonBodyParseError } from "@/lib/http/request-body";
import { listWorkspaceRepositoryOptions } from "@/lib/backend/workspace/repository-inventory";
import {
  assertWorkspaceUsageWithinBillingLimits,
  WorkspaceBillingLimitError,
} from "@/lib/backend/workspace/workspace-billing";
import { createRequestId, jsonWithRequestId, logRouteError } from "@/lib/observability/route-response";
import {
  RepositoryConnectionBootstrapSchema,
  RepositoryConnectionSaveResponseSchema,
  RepositoryConnectionUpdateSchema,
  type WorkspaceSession,
} from "@/schemas/cloud";

async function buildRepositoryBootstrap(access: { workspaceSession: WorkspaceSession }) {
  const availableRepositories = await listWorkspaceRepositoryOptions(access.workspaceSession.activeWorkspace.id);
  const persistedState = await getWorkspaceConnectionState(access.workspaceSession.activeWorkspace.id);
  const connectors = await listWorkspaceConnectors(
    access.workspaceSession.activeWorkspace.id,
    new Date().toISOString(),
  );
  const repositoryIdByKey = new Map(
    availableRepositories.map((repository) => [`${repository.owner}/${repository.name}`, repository.id] as const),
  );
  const activeConnectorRepositoryIds = connectors.items
    .filter((connector) => connector.status === "active")
    .map((connector) => repositoryIdByKey.get(`${connector.repositoryOwner}/${connector.repositoryName}`))
    .filter((value): value is string => typeof value === "string");

  return RepositoryConnectionBootstrapSchema.parse({
    availableRepositories,
    connectedRepositoryIds: persistedState?.repositoryIds ?? [],
    activeConnectorCount: connectors.items.filter((connector) => connector.status === "active").length,
    totalConnectorCount: connectors.total,
    staleConnectorCount: connectors.items.filter((connector) => connector.status === "stale").length,
    revokedConnectorCount: connectors.items.filter((connector) => connector.status === "revoked").length,
    activeConnectorRepositoryIds,
    launchedAt: persistedState?.launchedAt ?? null,
  });
}

export async function GET(request: Request) {
  const requestId = createRequestId(request);
  const access = await requireApiRole("admin", request);

  if (access.denied) {
    return access.denied;
  }

  try {
    return jsonWithRequestId(await buildRepositoryBootstrap(access), undefined, requestId);
  } catch (error) {
    logRouteError("repository_connect_bootstrap_get", requestId, error, {
      workspaceId: access.workspaceSession.activeWorkspace.id,
    });
    return jsonWithRequestId(
      { message: "Could not load repository connection setup. Retry." },
      { status: 500 },
      requestId,
    );
  }
}

export async function POST(request: Request) {
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

  const payload = RepositoryConnectionUpdateSchema.safeParse(rawPayload);
  if (!payload.success) {
    return jsonWithRequestId({ message: "Repository connection payload is invalid." }, { status: 400 }, requestId);
  }

  try {
    const bootstrap = await buildRepositoryBootstrap(access);
    const knownRepositoryIds = new Set(bootstrap.availableRepositories.map((repository) => repository.id));
    const requestedRepositoryIds = [...new Set(payload.data.repositoryIds)].filter((repositoryId) =>
      knownRepositoryIds.has(repositoryId),
    );

    if (requestedRepositoryIds.length !== payload.data.repositoryIds.length) {
      return jsonWithRequestId(
        { message: "One or more selected repositories could not be found." },
        { status: 400 },
        requestId,
      );
    }

    const previousState = await getWorkspaceConnectionState(access.workspaceSession.activeWorkspace.id);
    const savedAt = new Date().toISOString();
    const newlyConnectedRepositoryIds = requestedRepositoryIds.filter(
      (repositoryId) => !(previousState?.repositoryIds ?? []).includes(repositoryId),
    );

    await assertWorkspaceUsageWithinBillingLimits(access.workspaceSession, {
      usageOverrides: {
        repositoriesConnected: requestedRepositoryIds.length,
      },
      dimensions: ["repositories"],
    });

    await saveWorkspaceConnectionState({
      workspaceId: access.workspaceSession.activeWorkspace.id,
      workspaceName: previousState?.workspaceName ?? access.workspaceSession.activeWorkspace.name,
      workspaceSlug: previousState?.workspaceSlug ?? access.workspaceSession.activeWorkspace.slug,
      repositoryIds: requestedRepositoryIds,
      members: previousState?.members ?? [
        {
          name: access.workspaceSession.user.name,
          email: access.workspaceSession.user.email,
          role: access.workspaceSession.activeWorkspace.role,
        },
      ],
      invites: previousState?.invites ?? [],
      defaultNotificationChannel: previousState?.defaultNotificationChannel ?? "slack",
      policyPack: previousState?.policyPack ?? "guarded",
      launchedAt: previousState?.launchedAt ?? savedAt,
    });

    const connectorBootstrapSuggested =
      requestedRepositoryIds.length > 0 &&
      requestedRepositoryIds.some((repositoryId) => !bootstrap.activeConnectorRepositoryIds.includes(repositoryId));

    return jsonWithRequestId(
      RepositoryConnectionSaveResponseSchema.parse({
        connectedRepositoryIds: requestedRepositoryIds,
        connectedRepositoryCount: requestedRepositoryIds.length,
        newlyConnectedRepositoryIds,
        connectorBootstrapSuggested,
        savedAt,
        message:
          requestedRepositoryIds.length === 0
            ? "Repository access was cleared for this workspace."
            : connectorBootstrapSuggested
              ? "Repositories connected. Bootstrap a local connector to sync live repo state."
              : "Repositories connected and ready for governed work.",
      }),
      undefined,
      requestId,
    );
  } catch (error) {
    if (error instanceof WorkspaceBillingLimitError) {
      return jsonWithRequestId({ message: error.message, breaches: error.breaches }, { status: 409 }, requestId);
    }

    logRouteError("repository_connect_bootstrap_post", requestId, error, {
      workspaceId: access.workspaceSession.activeWorkspace.id,
    });
    return jsonWithRequestId(
      { message: "Could not update repository connections. Retry." },
      { status: 500 },
      requestId,
    );
  }
}
