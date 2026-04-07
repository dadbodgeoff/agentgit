import { Badge, Card } from "@/components/primitives";
import type { WorkspaceRole } from "@/schemas/cloud";

export function AccessDeniedState({
  currentRole,
  requiredRole,
  resourceLabel = "this route",
}: {
  currentRole: WorkspaceRole;
  requiredRole: WorkspaceRole;
  resourceLabel?: string;
}) {
  return (
    <Card className="border-dashed">
      <div className="flex max-w-2xl flex-col gap-4 py-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="error">Access denied</Badge>
          <Badge>Current role: {currentRole}</Badge>
          <Badge>Required: {requiredRole}</Badge>
        </div>
        <div className="space-y-2">
          <h2 className="text-xl font-semibold">You do not have permission to access {resourceLabel}.</h2>
          <p className="text-sm text-[var(--ag-text-secondary)]">
            Ask a workspace {requiredRole} to grant access if you need to manage this surface.
          </p>
        </div>
      </div>
    </Card>
  );
}
