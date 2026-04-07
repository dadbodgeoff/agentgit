import { RepositoryRunsPage } from "@/features/repos/repository-runs-page";
import { parsePreviewStateValue } from "@/lib/navigation/search-params";

export default async function RepositoryRunsRoute({
  params,
  searchParams,
}: {
  params: Promise<{ owner: string; name: string }>;
  searchParams?: Promise<{ state?: string | string[] }>;
}) {
  const { owner, name } = await params;
  const resolvedSearchParams = await searchParams;
  const previewState = parsePreviewStateValue(resolvedSearchParams?.state);

  return <RepositoryRunsPage name={name} owner={owner} previewState={previewState} />;
}
