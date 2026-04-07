import "server-only";

import { AuthorityClient } from "@agentgit/authority-sdk";
import { collectWorkspaceRepositoryRuntimeRecords } from "@/lib/backend/workspace/repository-inventory";
import { resolveWorkspaceRoots } from "@/lib/backend/workspace/roots";

export async function withScopedAuthorityClient<T>(
  workspaceRoots: string[],
  run: (client: AuthorityClient) => Promise<T>,
): Promise<T> {
  const client = new AuthorityClient({
    clientType: "ui",
    clientVersion: "0.1.0",
    defaultWorkspaceRoots: workspaceRoots,
  });

  await client.hello(workspaceRoots);
  return run(client);
}

export async function withAuthorityClient<T>(run: (client: AuthorityClient) => Promise<T>): Promise<T> {
  return withScopedAuthorityClient(resolveWorkspaceRoots(), run);
}

export function resolveAuthorityWorkspaceRoots(workspaceId: string): string[] {
  return [...new Set(collectWorkspaceRepositoryRuntimeRecords(workspaceId).map((record) => record.metadata.root))];
}

export async function withWorkspaceAuthorityClient<T>(
  workspaceId: string,
  run: (client: AuthorityClient) => Promise<T>,
): Promise<T> {
  return withScopedAuthorityClient(resolveAuthorityWorkspaceRoots(workspaceId), run);
}
