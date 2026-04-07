import { fetchJson } from "@/lib/api/client";
import { RepositoryListResponseSchema, type PreviewState, type RepositoryListResponse } from "@/schemas/cloud";

export async function getRepositories(previewState: PreviewState = "ready"): Promise<RepositoryListResponse> {
  const url = new URL("/api/v1/repos", "http://localhost");
  if (previewState !== "ready") {
    url.searchParams.set("state", previewState);
  }

  const response = await fetchJson<unknown>(url.pathname + url.search);
  return RepositoryListResponseSchema.parse(response);
}
