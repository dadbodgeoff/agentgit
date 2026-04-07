import { RepositoryListResponseSchema, type PreviewState, type RepositoryListResponse } from "@/schemas/cloud";

const repositoriesReadyFixture = RepositoryListResponseSchema.parse({
  items: [
    {
      id: "repo_abc123",
      owner: "acme",
      name: "api-gateway",
      defaultBranch: "main",
      repositoryStatus: "active",
      lastRunStatus: "completed",
      lastUpdatedAt: "2026-04-06T14:32:34Z",
      agentStatus: "healthy",
    },
    {
      id: "repo_def456",
      owner: "acme",
      name: "platform-ui",
      defaultBranch: "main",
      repositoryStatus: "active",
      lastRunStatus: "failed",
      lastUpdatedAt: "2026-04-06T14:05:00Z",
      agentStatus: "escalated",
    },
  ],
  total: 2,
  page: 1,
  per_page: 25,
  has_more: false,
});

const repositoriesEmptyFixture = RepositoryListResponseSchema.parse({
  items: [],
  total: 0,
  page: 1,
  per_page: 25,
  has_more: false,
});

export function getRepositoriesFixture(previewState: PreviewState): RepositoryListResponse {
  return previewState === "empty" ? repositoriesEmptyFixture : repositoriesReadyFixture;
}
