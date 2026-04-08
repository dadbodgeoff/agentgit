import { fetchJson } from "@/lib/api/client";
import { appendCursorPagination, type CursorPaginationRequest } from "@/lib/api/endpoints/pagination";
import {
  RepositoryConnectionBootstrapSchema,
  RepositoryConnectionSaveResponseSchema,
  RepositoryConnectionUpdateSchema,
  RepositoryDetailSchema,
  RepositoryListResponseSchema,
  RepositoryPolicySaveResponseSchema,
  RepositoryPolicySnapshotSchema,
  RepositoryPolicyValidationSchema,
  RepositorySnapshotsResponseSchema,
  RepositoryRunsResponseSchema,
  RunReplayPreviewSchema,
  RunReplayQueuedResponseSchema,
  SnapshotRestoreExecutionResultSchema,
  SnapshotRestorePreviewSchema,
  type PreviewState,
  type RepositoryConnectionBootstrap,
  type RepositoryConnectionSaveResponse,
  type RepositoryConnectionUpdate,
  type RepositoryDetail,
  type RepositoryListResponse,
  type RepositoryPolicySaveResponse,
  type RepositoryPolicySnapshot,
  type RepositoryPolicyValidation,
  type RepositorySnapshotsResponse,
  type RepositoryRunsResponse,
  type RunReplayPreview,
  type RunReplayQueuedResponse,
  type SnapshotRestoreExecutionResult,
  type SnapshotRestorePreview,
} from "@/schemas/cloud";

export async function getRepositories(
  params: CursorPaginationRequest & { previewState?: PreviewState } = {},
): Promise<RepositoryListResponse> {
  const url = appendCursorPagination(new URL("/api/v1/repos", "http://localhost"), params);

  const response = await fetchJson<unknown>(url.pathname + url.search);
  return RepositoryListResponseSchema.parse(response);
}

export async function getRepositoryConnectionBootstrap(): Promise<RepositoryConnectionBootstrap> {
  const response = await fetchJson<unknown>("/api/v1/repos/connect");
  return RepositoryConnectionBootstrapSchema.parse(response);
}

export async function updateWorkspaceRepositories(
  values: RepositoryConnectionUpdate,
): Promise<RepositoryConnectionSaveResponse> {
  const response = await fetchJson<unknown>("/api/v1/repos/connect", {
    method: "POST",
    body: JSON.stringify(RepositoryConnectionUpdateSchema.parse(values)),
  });

  return RepositoryConnectionSaveResponseSchema.parse(response);
}

export async function getRepositoryDetail(
  owner: string,
  name: string,
  previewState: PreviewState = "ready",
): Promise<RepositoryDetail> {
  const url = new URL(
    `/api/v1/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
    "http://localhost",
  );
  if (previewState !== "ready") {
    url.searchParams.set("state", previewState);
  }

  const response = await fetchJson<unknown>(url.pathname + url.search);
  return RepositoryDetailSchema.parse(response);
}

export async function getRepositoryRuns(
  owner: string,
  name: string,
  params: CursorPaginationRequest & { previewState?: PreviewState } = {},
): Promise<RepositoryRunsResponse> {
  const url = appendCursorPagination(
    new URL(`/api/v1/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/runs`, "http://localhost"),
    params,
  );

  const response = await fetchJson<unknown>(url.pathname + url.search);
  return RepositoryRunsResponseSchema.parse(response);
}

export async function getRepositoryRunReplay(owner: string, name: string, runId: string): Promise<RunReplayPreview> {
  const response = await fetchJson<unknown>(
    `/api/v1/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/runs/${encodeURIComponent(runId)}/replay`,
  );
  return RunReplayPreviewSchema.parse(response);
}

export async function queueRepositoryRunReplay(
  owner: string,
  name: string,
  runId: string,
): Promise<RunReplayQueuedResponse> {
  const response = await fetchJson<unknown>(
    `/api/v1/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/runs/${encodeURIComponent(runId)}/replay`,
    {
      method: "POST",
    },
  );
  return RunReplayQueuedResponseSchema.parse(response);
}

export async function getRepositoryPolicy(
  owner: string,
  name: string,
  previewState: PreviewState = "ready",
): Promise<RepositoryPolicySnapshot> {
  const url = new URL(
    `/api/v1/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/policy`,
    "http://localhost",
  );
  if (previewState !== "ready") {
    url.searchParams.set("state", previewState);
  }

  const response = await fetchJson<unknown>(url.pathname + url.search);
  return RepositoryPolicySnapshotSchema.parse(response);
}

export async function getRepositorySnapshots(
  owner: string,
  name: string,
  params: CursorPaginationRequest & { previewState?: PreviewState } = {},
): Promise<RepositorySnapshotsResponse> {
  const url = appendCursorPagination(
    new URL(
      `/api/v1/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/snapshots`,
      "http://localhost",
    ),
    params,
  );

  const response = await fetchJson<unknown>(url.pathname + url.search);
  return RepositorySnapshotsResponseSchema.parse(response);
}

export async function validateRepositoryPolicy(
  owner: string,
  name: string,
  document: string,
): Promise<RepositoryPolicyValidation> {
  const response = await fetchJson<unknown>(
    `/api/v1/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/policy`,
    {
      method: "POST",
      body: JSON.stringify({ document }),
    },
  );

  return RepositoryPolicyValidationSchema.parse(response);
}

export async function updateRepositoryPolicy(
  owner: string,
  name: string,
  document: string,
): Promise<RepositoryPolicySaveResponse> {
  const response = await fetchJson<unknown>(
    `/api/v1/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/policy`,
    {
      method: "PUT",
      body: JSON.stringify({ document }),
    },
  );

  return RepositoryPolicySaveResponseSchema.parse(response);
}

export async function rollbackRepositoryPolicyVersion(
  owner: string,
  name: string,
  versionId: string,
): Promise<RepositoryPolicySaveResponse> {
  const response = await fetchJson<unknown>(
    `/api/v1/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/policy`,
    {
      method: "PATCH",
      body: JSON.stringify({ versionId }),
    },
  );

  return RepositoryPolicySaveResponseSchema.parse(response);
}

export async function previewSnapshotRestore(
  owner: string,
  name: string,
  snapshotId: string,
): Promise<SnapshotRestorePreview> {
  const response = await fetchJson<unknown>(
    `/api/v1/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/snapshots/${encodeURIComponent(snapshotId)}/restore`,
    {
      method: "POST",
      body: JSON.stringify({ intent: "plan" }),
    },
  );

  return SnapshotRestorePreviewSchema.parse(response);
}

export async function executeSnapshotRestore(
  owner: string,
  name: string,
  snapshotId: string,
): Promise<SnapshotRestoreExecutionResult> {
  const response = await fetchJson<unknown>(
    `/api/v1/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/snapshots/${encodeURIComponent(snapshotId)}/restore`,
    {
      method: "POST",
      body: JSON.stringify({ intent: "execute" }),
    },
  );

  return SnapshotRestoreExecutionResultSchema.parse(response);
}
