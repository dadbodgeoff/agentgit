import { redirect } from "next/navigation";

import { AccessDeniedState } from "@/components/feedback";
import { RepositorySnapshotsPage } from "@/features/repos/repository-snapshots-page";
import { publicRoutes, repositorySnapshotsRoute } from "@/lib/navigation/routes";
import { parsePreviewStateValue } from "@/lib/navigation/search-params";
import { getRoleAccess } from "@/lib/rbac/access";

export default async function SnapshotsRoute({
  params,
  searchParams,
}: {
  params: Promise<{ owner: string; name: string }>;
  searchParams?: Promise<{ state?: string | string[] }>;
}) {
  const { owner, name } = await params;
  const access = await getRoleAccess("member");

  if (!access.session) {
    redirect(`${publicRoutes.signIn}?callbackUrl=${encodeURIComponent(repositorySnapshotsRoute(owner, name))}`);
  }

  if (!access.allowed) {
    return (
      <AccessDeniedState
        currentRole={access.session.activeWorkspace.role}
        requiredRole={access.requiredRole}
        resourceLabel="repository snapshots"
      />
    );
  }

  const resolvedSearchParams = await searchParams;
  const previewState = parsePreviewStateValue(resolvedSearchParams?.state);

  return <RepositorySnapshotsPage name={name} owner={owner} previewState={previewState} />;
}
