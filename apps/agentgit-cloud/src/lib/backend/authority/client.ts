import "server-only";

import path from "node:path";

import { AuthorityClient } from "@agentgit/authority-sdk";
import { collectWorkspaceRepositoryRuntimeRecords } from "@/lib/backend/workspace/repository-inventory";
import { resolveWorkspaceRoots } from "@/lib/backend/workspace/roots";

export function resolveAuthoritySocketPath(workspaceRoots: string[]): string | undefined {
  if (process.env.AGENTGIT_SOCKET_PATH) {
    return process.env.AGENTGIT_SOCKET_PATH;
  }

  const [primaryRoot] = workspaceRoots.filter((root) => root.trim().length > 0);
  if (!primaryRoot) {
    return undefined;
  }

  return path.resolve(primaryRoot, ".agentgit", "authority.sock");
}

export async function withScopedAuthorityClient<T>(
  workspaceRoots: string[],
  run: (client: AuthorityClient) => Promise<T>,
): Promise<T> {
  const client = new AuthorityClient({
    clientType: "ui",
    clientVersion: "0.1.0",
    defaultWorkspaceRoots: workspaceRoots,
    socketPath: resolveAuthoritySocketPath(workspaceRoots),
  });

  await client.hello(workspaceRoots);
  return run(client);
}

export async function withAuthorityClient<T>(run: (client: AuthorityClient) => Promise<T>): Promise<T> {
  return withScopedAuthorityClient(resolveWorkspaceRoots(), run);
}

export async function resolveAuthorityWorkspaceRoots(workspaceId: string): Promise<string[]> {
  const runtimeRoots = [...new Set((await collectWorkspaceRepositoryRuntimeRecords(workspaceId)).map((record) => record.metadata.root))];
  return runtimeRoots;
}

export async function withWorkspaceAuthorityClient<T>(
  workspaceId: string,
  run: (client: AuthorityClient) => Promise<T>,
): Promise<T> {
  return withScopedAuthorityClient(await resolveAuthorityWorkspaceRoots(workspaceId), run);
}
