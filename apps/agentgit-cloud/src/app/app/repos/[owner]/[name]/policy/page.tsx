import { redirect } from "next/navigation";

import { AccessDeniedState } from "@/components/feedback";
import { RepositoryPolicyPage } from "@/features/repos/repository-policy-page";
import { publicRoutes, repositoryPolicyRoute } from "@/lib/navigation/routes";
import { parsePreviewStateValue } from "@/lib/navigation/search-params";
import { getRoleAccess } from "@/lib/rbac/access";

export default async function RepositoryPolicyRoute({
  params,
  searchParams,
}: {
  params: Promise<{ owner: string; name: string }>;
  searchParams?: Promise<{ state?: string | string[] }>;
}) {
  const { owner, name } = await params;
  const access = await getRoleAccess("admin");

  if (!access.session) {
    redirect(`${publicRoutes.signIn}?callbackUrl=${encodeURIComponent(repositoryPolicyRoute(owner, name))}`);
  }

  if (!access.allowed) {
    return (
      <AccessDeniedState
        currentRole={access.session.activeWorkspace.role}
        requiredRole={access.requiredRole}
        resourceLabel="repository policy"
      />
    );
  }

  const resolvedSearchParams = await searchParams;
  const previewState = parsePreviewStateValue(resolvedSearchParams?.state);

  return <RepositoryPolicyPage name={name} owner={owner} previewState={previewState} />;
}
