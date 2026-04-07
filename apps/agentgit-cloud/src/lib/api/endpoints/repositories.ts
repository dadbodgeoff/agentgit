import { fetchJson } from "@/lib/api/client";
import {
  RepositoryDetailSchema,
  RepositoryListResponseSchema,
  RepositoryPolicySaveResponseSchema,
  RepositoryPolicySnapshotSchema,
  RepositoryPolicyValidationSchema,
  RepositorySnapshotsResponseSchema,
  RepositoryRunsResponseSchema,
  SnapshotRestoreExecutionResultSchema,
  SnapshotRestorePreviewSchema,
  type PreviewState,
  type RepositoryDetail,
  type RepositoryListResponse,
  type RepositoryPolicySaveResponse,
  type RepositoryPolicySnapshot,
  type RepositoryPolicyValidation,
  type RepositorySnapshotsResponse,
  type RepositoryRunsResponse,
  type SnapshotRestoreExecutionResult,
  type SnapshotRestorePreview,
} from "@/schemas/cloud";

export async function getRepositories(previewState: PreviewState = "ready"): Promise<RepositoryListResponse> {
  const url = new URL("/api/v1/repos", "http://localhost");
  if (previewState !== "ready") {
    url.searchParams.set("state", previewState);
  }

  const response = await fetchJson<unknown>(url.pathname + url.search);
  return RepositoryListResponseSchema.parse(response);
}

export async function getRepositoryDetail(
  owner: string,
  name: string,
  previewState: PreviewState = "ready",
): Promise<RepositoryDetail> {
  const url = new URL(`/api/v1/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, "http://localhost");
  if (previewState !== "ready") {
    url.searchParams.set("state", previewState);
  }

  const response = await fetchJson<unknown>(url.pathname + url.search);
  return RepositoryDetailSchema.parse(response);
}

export async function getRepositoryRuns(
  owner: string,
  name: string,
  previewState: PreviewState = "ready",
): Promise<RepositoryRunsResponse> {
  const url = new URL(
    `/api/v1/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/runs`,
    "http://localhost",
  );
  if (previewState !== "ready") {
    url.searchParams.set("state", previewState);
  }

  const response = await fetchJson<unknown>(url.pathname + url.search);
  return RepositoryRunsResponseSchema.parse(response);
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
  previewState: PreviewState = "ready",
): Promise<RepositorySnapshotsResponse> {
  const url = new URL(
    `/api/v1/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/snapshots`,
    "http://localhost",
  );
  if (previewState !== "ready") {
    url.searchParams.set("state", previewState);
  }

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

export async function previewSnapshotRestore(owner: string, name: string, snapshotId: string): Promise<SnapshotRestorePreview> {
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
