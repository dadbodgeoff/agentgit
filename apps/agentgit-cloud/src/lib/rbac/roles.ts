import { WorkspaceRoleSchema, type WorkspaceRole } from "@/schemas/cloud";

export const workspaceRoleOrder: WorkspaceRole[] = ["member", "admin", "owner"];

export function isWorkspaceRole(value: string): value is WorkspaceRole {
  return WorkspaceRoleSchema.safeParse(value).success;
}

export function hasAtLeastRole(currentRole: WorkspaceRole, requiredRole: WorkspaceRole): boolean {
  return workspaceRoleOrder.indexOf(currentRole) >= workspaceRoleOrder.indexOf(requiredRole);
}
