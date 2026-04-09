import "server-only";

import { findRepositoryRuntimeRecord } from "@/lib/backend/workspace/repository-inventory";

export async function hasRepositoryRouteAccess(params: {
  owner: string;
  name: string;
  workspaceId: string;
}): Promise<boolean> {
  return (await findRepositoryRuntimeRecord(params.owner, params.name, params.workspaceId)) !== null;
}
