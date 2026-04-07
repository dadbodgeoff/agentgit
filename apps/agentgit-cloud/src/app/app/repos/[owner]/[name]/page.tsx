import { RepositoryDetailPage } from "@/features/repos/repository-detail-page";
import { parsePreviewStateValue } from "@/lib/navigation/search-params";

export default async function RepositoryDetailRoute({
  params,
  searchParams,
}: {
  params: Promise<{ owner: string; name: string }>;
  searchParams?: Promise<{ state?: string | string[] }>;
}) {
  const { owner, name } = await params;
  const resolvedSearchParams = await searchParams;
  const previewState = parsePreviewStateValue(resolvedSearchParams?.state);

  return <RepositoryDetailPage name={name} owner={owner} previewState={previewState} />;
}
